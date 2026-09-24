export interface MenuItem {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  created_at: string;
}

export interface OrderItem {
  id: string;
  menu_item_id: string;
  name: string;
  unit_price_cents: number;
  quantity: number;
}

export interface Order {
  id: string;
  customer_id: string;
  status: "PLACED" | "READY" | "CANCELLED";
  total_cents: number;
  created_at: string;
  items: OrderItem[];
}

export interface OutboxEvent {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
  status: "PENDING" | "SENT";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

export interface DlqRow {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
  attempts: number;
  last_error: string | null;
  moved_at: string;
}

export interface TicketEvent {
  id: string;
  type: string;
  payload: {
    orderId: string;
    status: string;
    customerId?: string;
    totalCents?: number;
    items?: OrderItem[];
  };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listMenu: () => request<MenuItem[]>("/menu"),
  createMenuItem: (name: string, priceCents: number) =>
    request<MenuItem>("/menu", {
      method: "POST",
      body: JSON.stringify({ name, priceCents }),
    }),
  updateMenuItem: (id: string, changes: Partial<Pick<MenuItem, "name" | "price_cents" | "is_available">>) =>
    request<MenuItem>(`/menu/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: changes.name,
        priceCents: changes.price_cents,
        isAvailable: changes.is_available,
      }),
    }),
  deleteMenuItem: (id: string) => request<void>(`/menu/${id}`, { method: "DELETE" }),

  createOrder: (customerId: string, items: { menuItemId: string; quantity: number }[]) =>
    request<Order>("/orders", {
      method: "POST",
      body: JSON.stringify({ customerId, items }),
    }),
  listOrders: () => request<Order[]>("/orders"),
  updateOrderStatus: (id: string, status: "READY" | "CANCELLED") =>
    request<Order>(`/orders/${id}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),

  listOutbox: () => request<OutboxEvent[]>("/outbox"),
  listDlq: () => request<DlqRow[]>("/outbox/dlq"),
  replayDlq: () => request<{ replayed: number }>("/outbox/dlq/replay", { method: "POST" }),
};

/** Subscribes to the Kitchen Display Service's live outbox event stream. */
export function subscribeKitchenStream(onEvent: (event: TicketEvent) => void): () => void {
  const source = new EventSource("/api/kitchen/stream");
  source.onmessage = (msg) => {
    onEvent(JSON.parse(msg.data));
  };
  return () => source.close();
}
