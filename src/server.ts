import express, { Request, Response } from "express";
import cors from "cors";
import { createOrder, listOrders, updateOrderStatus } from "./orderService";
import {
  createMenuItem,
  deleteMenuItem,
  listMenuItems,
  updateMenuItem,
} from "./menuService";
import {
  listRecentOutboxEvents,
  listDlqRows,
  replayAllDlqRows,
} from "./outboxRepository";
import { OutboxRelay } from "./relay";
import { kitchenEvents } from "./kitchenBroadcaster";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// The relay runs in-process alongside the API for this demo. In production
// it would typically be its own deployable (or replaced by Debezium/CDC).
const relay = new OutboxRelay();
relay.start();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ---- Menu (admin CRUD, no outbox — this is reference data, not an event) ----

app.get("/api/menu", async (_req: Request, res: Response) => {
  try {
    res.json(await listMenuItems());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list menu" });
  }
});

app.post("/api/menu", async (req: Request, res: Response) => {
  const { name, priceCents, isAvailable } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || !Number.isFinite(priceCents) || priceCents <= 0) {
    return res
      .status(400)
      .json({ error: "name (string) and priceCents (positive number) are required" });
  }
  try {
    const item = await createMenuItem({ name, priceCents, isAvailable });
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create menu item" });
  }
});

app.put("/api/menu/:id", async (req: Request, res: Response) => {
  const { name, priceCents, isAvailable } = req.body ?? {};
  try {
    const item = await updateMenuItem(req.params.id, { name, priceCents, isAvailable });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "Menu item not found" });
  }
});

app.delete("/api/menu/:id", async (req: Request, res: Response) => {
  try {
    await deleteMenuItem(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "Menu item not found" });
  }
});

// ---- Orders (domain write + outbox write, one transaction — the pattern) ----

app.post("/api/orders", async (req: Request, res: Response) => {
  const { customerId, items } = req.body ?? {};
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: "customerId must be a valid UUID" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items must be a non-empty array" });
  }
  for (const item of items) {
    if (!item.menuItemId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res
        .status(400)
        .json({ error: "each item needs menuItemId and a positive integer quantity" });
    }
  }
  try {
    const order = await createOrder(customerId, items);
    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to create order";
    res.status(400).json({ error: message });
  }
});

app.get("/api/orders", async (_req: Request, res: Response) => {
  try {
    res.json(await listOrders());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list orders" });
  }
});

app.put("/api/orders/:id/status", async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (status !== "READY" && status !== "CANCELLED") {
    return res.status(400).json({ error: "status must be READY or CANCELLED" });
  }
  try {
    const order = await updateOrderStatus(req.params.id, status);
    res.json(order);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to update order";
    res.status(400).json({ error: message });
  }
});

// ---- Outbox / DLQ (read-only views + replay) ----

app.get("/api/outbox", async (_req: Request, res: Response) => {
  try {
    res.json(await listRecentOutboxEvents(50));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list outbox events" });
  }
});

app.get("/api/outbox/dlq", async (_req: Request, res: Response) => {
  try {
    res.json(await listDlqRows());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list DLQ rows" });
  }
});

app.post("/api/outbox/dlq/replay", async (_req: Request, res: Response) => {
  try {
    const count = await replayAllDlqRows();
    res.json({ replayed: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to replay DLQ" });
  }
});

// ---- Kitchen Display Service: consumes outbox events over SSE ----
// Stands in for a real KDS subscribing to the broker (Kafka/RabbitMQ/etc).
// Here the "broker" is ConsolePublisher, which taps every publish into
// kitchenEvents — this route just forwards that stream to the browser.

app.get("/api/kitchen/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const onTicket = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  kitchenEvents.on("ticket", onTicket);

  req.on("close", () => {
    kitchenEvents.off("ticket", onTicket);
  });
});

app.listen(PORT, () => {
  console.log(`Outbox API listening on http://localhost:${PORT}`);
});
