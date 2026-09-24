import { pool } from "./db";
import { insertOutboxEvent } from "./outboxRepository";

export interface OrderItemInput {
  menuItemId: string;
  quantity: number;
}

export type OrderStatus = "PLACED" | "READY" | "CANCELLED";

// Domain write (order + order_items) + outbox row, one DB transaction. This
// is the whole pattern: either the order and its OrderPlaced event both
// commit, or neither does.
export async function createOrder(customerId: string, items: OrderItemInput[]) {
  if (items.length === 0) {
    throw new Error("Order must include at least one item");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const menuItemIds = items.map((i) => i.menuItemId);
    const { rows: menuRows } = await client.query(
      `SELECT id, name, price_cents FROM menu_items WHERE id = ANY($1) AND is_available = true`,
      [menuItemIds]
    );
    const menuById = new Map(menuRows.map((r) => [r.id, r]));
    for (const item of items) {
      if (!menuById.has(item.menuItemId)) {
        throw new Error(`Menu item ${item.menuItemId} is not available`);
      }
    }

    const totalCents = items.reduce((sum, item) => {
      const menuItem = menuById.get(item.menuItemId)!;
      return sum + menuItem.price_cents * item.quantity;
    }, 0);

    const { rows } = await client.query(
      `INSERT INTO orders (customer_id, total_cents, status)
       VALUES ($1, $2, 'PLACED')
       RETURNING id, customer_id, status, total_cents, created_at`,
      [customerId, totalCents]
    );
    const order = rows[0];

    const orderItems = [];
    for (const item of items) {
      const menuItem = menuById.get(item.menuItemId)!;
      const { rows: itemRows } = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, quantity)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, menu_item_id, name, unit_price_cents, quantity`,
        [order.id, item.menuItemId, menuItem.name, menuItem.price_cents, item.quantity]
      );
      orderItems.push(itemRows[0]);
    }

    await insertOutboxEvent(client, {
      aggregateId: order.id,
      aggregateType: "Order",
      eventType: "OrderPlaced",
      payload: {
        orderId: order.id,
        customerId,
        status: order.status,
        totalCents: order.total_cents,
        items: orderItems,
      },
    });

    await client.query("COMMIT");
    return { ...order, items: orderItems };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Status transition (kitchen marks ready, or an order is cancelled) + outbox
// row, same transaction. Only PLACED orders can transition — this is a
// terminal move either way, so double-submits are rejected rather than
// silently re-firing an event.
export async function updateOrderStatus(orderId: string, status: "READY" | "CANCELLED") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE orders
       SET status = $2
       WHERE id = $1 AND status = 'PLACED'
       RETURNING id, customer_id, status, total_cents, created_at`,
      [orderId, status]
    );
    if (rows.length === 0) {
      throw new Error("Order not found or is not in a PLACED state");
    }
    const order = rows[0];

    await insertOutboxEvent(client, {
      aggregateId: order.id,
      aggregateType: "Order",
      eventType: status === "READY" ? "OrderReady" : "OrderCancelled",
      payload: { orderId: order.id, status: order.status },
    });

    await client.query("COMMIT");
    return order;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listOrders() {
  const { rows: orders } = await pool.query(
    `SELECT id, customer_id, status, total_cents, created_at
     FROM orders
     ORDER BY created_at DESC
     LIMIT 50`
  );
  if (orders.length === 0) return [];

  const orderIds = orders.map((o) => o.id);
  const { rows: items } = await pool.query(
    `SELECT id, order_id, menu_item_id, name, unit_price_cents, quantity
     FROM order_items
     WHERE order_id = ANY($1)`,
    [orderIds]
  );
  const itemsByOrder = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  return orders.map((o) => ({ ...o, items: itemsByOrder.get(o.id) ?? [] }));
}
