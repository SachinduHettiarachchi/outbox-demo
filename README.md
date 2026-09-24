# Restaurant Order & Kitchen Display System (Node.js + TypeScript + Postgres)

A minimal, working implementation of the **Transactional Outbox (+ CDC-style relay)**
pattern from your slide, applied to a restaurant ordering domain: placing an
order writes the order + `OrderPlaced` event atomically, and a **Kitchen
Display Service** consumes that event stream live to show order tickets.

## The problem it solves

Writing a domain change to your DB and publishing an event to a broker are two
separate systems. If you do them as two separate calls, one can succeed while
the other fails — the DB and the broker drift out of sync (dual-write problem).

## The core idea (what this code does)

1. **`orderService.ts`** — writes the domain rows (`orders` + `order_items`)
   **and** an `outbox` row describing the event, in **one Postgres
   transaction**. Either both happen or neither does. This is the entire
   trick. Placing an order emits `OrderPlaced`; marking it ready or cancelling
   it emits `OrderReady` / `OrderCancelled` the same way.
2. **`relay.ts`** — a background poller (stand-in for a CDC process like
   Debezium) that reads pending outbox rows and publishes them to a broker via
   the `Publisher` interface, then marks them `SENT`.
3. **Kitchen Display Service** — the `/api/kitchen/stream` SSE route
   (`server.ts`) forwards every publish from `ConsolePublisher` to connected
   browsers in real time (`kitchenBroadcaster.ts`). `frontend/src/KitchenApp.tsx`
   is a second, standalone screen that subscribes to it and renders open
   tickets, removing one the moment `OrderReady`/`OrderCancelled` arrives — a
   real consumer reacting to the outbox stream, not polling `orders`.

```
orders(...) + order_items(...)      outbox(id PK, aggregate_id, type, payload_json, occurred_at, attempts, status)
```

## How each slide bullet maps to code

| Slide bullet | Where it lives |
|---|---|
| Write domain change + outbox row in one DB transaction | `orderService.ts` — single `BEGIN…COMMIT` |
| A relay (or CDC) publishes from the outbox to the broker | `relay.ts` polling loop + `Publisher` interface |
| Ordering: one writer per aggregate | `relay.ts` — at most one row per `aggregate_id` is processed per batch, so event N+1 never goes out before N succeeds |
| Poison rows: cap attempts, move to DLQ, human/automation follow-up | `relay.ts handleFailure()` → `outbox_dlq` table; `dlqTool.ts` to list/replay |
| Retries with backoff | `relay.ts` — exponential backoff (`2^attempts`, capped at 5 min) via `next_attempt_at` |
| Outbox growth: partition + periodic vacuum/archival | See **Production notes** below |

## Setup

Requires Postgres and Node 18+.

```bash
npm install
cp .env.example .env        # point DATABASE_URL at your Postgres
npm run migrate             # creates menu_items / orders / order_items / outbox / outbox_dlq
```

### Option A — CLI demo (no UI)

```bash
npm run dev                 # seeds a menu, creates demo orders, starts the relay
```

You'll see console output like:

```
[publish] topic=Order id=... type=OrderPlaced payload={"orderId":"...","customerId":"...","totalCents":2100,"items":[...]}
```

### Option B — API + two React frontends

Terminal 1 — start the API (also runs the relay in-process):

```bash
npm run server               # http://localhost:4000
```

Terminal 2 — start the frontend (serves both pages):

```bash
cd frontend
npm install
npm run dev                  # http://localhost:5173
```

- **http://localhost:5173** — the restaurant app: menu admin CRUD, placing
  orders, marking them ready/cancelled, plus the pipeline diagram, live
  outbox table, and DLQ panel (**Replay all**).
- **http://localhost:5173/kitchen.html** — the Kitchen Display: a dark
  ticket board that subscribes to `/api/kitchen/stream` (SSE) and adds/removes
  tickets live as `OrderPlaced`/`OrderReady`/`OrderCancelled` events arrive —
  no polling. Open it side by side with the restaurant app to watch tickets
  appear the instant an order is placed.

To watch retry/backoff/DLQ behavior without a real broker, set
`SIMULATE_FAILURES=true` in `.env` — the demo publisher will randomly throw.

### API endpoints (`src/server.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/menu` | List menu items |
| POST | `/api/menu` | Create a menu item |
| PUT | `/api/menu/:id` | Update a menu item (name/price/availability) |
| DELETE | `/api/menu/:id` | Delete a menu item |
| POST | `/api/orders` | Place an order (domain write + outbox write, one transaction) |
| GET | `/api/orders` | List recent orders with their items |
| PUT | `/api/orders/:id/status` | Mark `READY` or `CANCELLED` (outbox write, same transaction) |
| GET | `/api/outbox` | List recent outbox events + status/attempts |
| GET | `/api/outbox/dlq` | List dead-lettered (poison) rows |
| POST | `/api/outbox/dlq/replay` | Move all DLQ rows back into the outbox |
| GET | `/api/kitchen/stream` | SSE stream of outbox events, for the Kitchen Display |

### CLI alternative to the DLQ panel

```bash
npm run dlq:list
npm run dlq:replay
```

## Swapping in a real broker

Everything talks to the `Publisher` interface in `publisher.ts`:

```ts
export interface Publisher {
  publish(topic: string, event: OutboundEvent): Promise<void>;
}
```

Implement it against Kafka, RabbitMQ, SNS/SQS, etc., and pass it into
`new OutboxRelay(myPublisher)`. Nothing else changes.

## Using this for your own aggregates

Copy the pattern in `orderService.ts`:

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // 1. your normal domain write(s) on `client`
  // 2. insertOutboxEvent(client, { aggregateId, aggregateType, eventType, payload })
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
```

## Production notes (beyond this demo)

- **CDC instead of polling**: for lower latency and less DB load at scale, use
  Debezium (or similar) reading the Postgres WAL instead of the polling relay
  in `relay.ts`. The `outbox` table schema is CDC-ready as-is.
- **Multiple relay instances**: `FOR UPDATE SKIP LOCKED` already makes it safe
  to run more than one relay process concurrently; each will grab a disjoint
  batch.
- **Outbox growth**: this demo never deletes `SENT` rows. In production, either
  partition `outbox` by `occurred_at` and drop old partitions, or run a
  periodic job that deletes/archives `SENT` rows older than N days, plus
  routine `VACUUM`.
- **Exactly-once vs at-least-once**: this gives you **at-least-once** delivery
  (a crash between publish and marking `SENT` can redeliver). Make your
  consumers idempotent using the outbox row's `id` as a dedupe key.
