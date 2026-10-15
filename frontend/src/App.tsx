import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { api, DlqRow, MenuItem, Order, OutboxEvent } from "./api";

const POLL_MS = 2000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomCustomerId(): string {
  return crypto.randomUUID();
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function App() {
  const [customerId, setCustomerId] = useState(randomCustomerId());
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [newItemName, setNewItemName] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("10.00");
  const [orders, setOrders] = useState<Order[]>([]);
  const [outbox, setOutbox] = useState<OutboxEvent[]>([]);
  const [dlq, setDlq] = useState<DlqRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [m, o, ob, d] = await Promise.all([
        api.listMenu(),
        api.listOrders(),
        api.listOutbox(),
        api.listDlq(),
      ]);
      setMenu(m);
      setOrders(o);
      setOutbox(ob);
      setDlq(d);
      setOnline(true);
    } catch (err) {
      setOnline(false);
      setError(err instanceof Error ? err.message : "Failed to reach API");
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const pendingCount = outbox.filter((e) => e.status === "PENDING").length;
  const sentCount = outbox.filter((e) => e.status === "SENT").length;
  const availableMenu = menu.filter((m) => m.is_available);

  const selectedItems = Object.entries(quantities).filter(([, qty]) => qty > 0);
  const itemCount = selectedItems.reduce((sum, [, qty]) => sum + qty, 0);
  const orderTotalCents = selectedItems.reduce((sum, [menuItemId, qty]) => {
    const item = menu.find((m) => m.id === menuItemId);
    return sum + (item ? item.price_cents * qty : 0);
  }, 0);

  function setQty(id: string, qty: number) {
    setQuantities((q) => ({ ...q, [id]: Math.max(0, qty) }));
  }

  async function handleCreateOrder(e: FormEvent) {
    e.preventDefault();
    if (!UUID_RE.test(customerId)) {
      setError("Customer ID must be a valid UUID (e.g. from the auto-generated value).");
      return;
    }
    if (selectedItems.length === 0) {
      setError("Pick at least one menu item.");
      return;
    }
    setSubmitting(true);
    try {
      await api.createOrder(
        customerId,
        selectedItems.map(([menuItemId, quantity]) => ({ menuItemId, quantity }))
      );
      setCustomerId(randomCustomerId());
      setQuantities({});
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddMenuItem(e: FormEvent) {
    e.preventDefault();
    const priceCents = Math.round(Number(newItemPrice) * 100);
    if (!newItemName.trim() || !(priceCents > 0)) return;
    try {
      await api.createMenuItem(newItemName.trim(), priceCents);
      setNewItemName("");
      setNewItemPrice("10.00");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add menu item");
    }
  }

  async function handleToggleAvailability(item: MenuItem) {
    try {
      await api.updateMenuItem(item.id, { is_available: !item.is_available });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update menu item");
    }
  }

  async function handleDeleteMenuItem(id: string) {
    try {
      await api.deleteMenuItem(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete menu item");
    }
  }

  async function handleOrderStatus(id: string, status: "READY" | "CANCELLED") {
    try {
      await api.updateOrderStatus(id, status);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update order");
    }
  }

  async function handleReplay() {
    try {
      await api.replayDlq();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replay DLQ");
    }
  }

  return (
    <div className="app">
      <nav className="topbar">
        <div className="brand">
          <span className="brand-mark">🍕</span>
          <span>Outbox Kitchen</span>
        </div>
        <div className="topbar-right">
          <span className={`live-pill ${online ? "on" : "off"}`}>
            <span className="dot" />
            {online ? "Live" : "API offline"}
          </span>
          <a className="btn btn-ghost" href="/kitchen.html" target="_blank" rel="noreferrer">
            Open Kitchen Display ↗
          </a>
        </div>
      </nav>

      <main className="page">
        <header className="hero">
          <h1>Restaurant Order &amp; Kitchen Display</h1>
          <p>
            Placing an order writes the order and an <code>OrderPlaced</code> event in a
            single transaction. Status changes (<code>OrderReady</code>,{" "}
            <code>OrderCancelled</code>) flow through the same outbox.
          </p>
        </header>

        <Pipeline
          orders={orders.length}
          pending={pendingCount}
          sent={sentCount}
          dlq={dlq.length}
        />

        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="banner-close" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        <div className="grid grid-main">
          <section className="card">
            <CardHeader
              title="Place order"
              hint={
                <>
                  Writes <code>orders</code>, <code>order_items</code> and{" "}
                  <code>outbox</code> in one transaction.
                </>
              }
            />
            <form onSubmit={handleCreateOrder} className="order-form">
              <label className="field">
                <span className="field-label">Customer ID</span>
                <div className="input-group">
                  <input
                    className="mono"
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title="Generate new ID"
                    onClick={() => setCustomerId(randomCustomerId())}
                  >
                    ↻
                  </button>
                </div>
              </label>

              <div className="menu-picker">
                {availableMenu.map((item) => {
                  const qty = quantities[item.id] ?? 0;
                  return (
                    <div key={item.id} className={`pick ${qty > 0 ? "picked" : ""}`}>
                      <div className="pick-info">
                        <div className="pick-name">{item.name}</div>
                        <div className="pick-price">{money(item.price_cents)}</div>
                      </div>
                      <div className="stepper">
                        <button
                          type="button"
                          onClick={() => setQty(item.id, qty - 1)}
                          disabled={qty === 0}
                          aria-label={`Remove one ${item.name}`}
                        >
                          −
                        </button>
                        <span>{qty}</span>
                        <button
                          type="button"
                          onClick={() => setQty(item.id, qty + 1)}
                          aria-label={`Add one ${item.name}`}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
                {availableMenu.length === 0 && (
                  <Empty>Add an available menu item first.</Empty>
                )}
              </div>

              <div className="checkout">
                <div>
                  <div className="checkout-label">
                    {itemCount} item{itemCount === 1 ? "" : "s"}
                  </div>
                  <div className="checkout-total">{money(orderTotalCents)}</div>
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting || itemCount === 0}
                >
                  {submitting ? "Placing…" : "Place order"}
                </button>
              </div>
            </form>
          </section>

          <section className="card">
            <CardHeader
              title="Orders"
              count={orders.length}
              hint="Mark ready or cancel — both write an outbox event."
            />
            <div className="order-list">
              {orders.map((o) => (
                <div key={o.id} className="order">
                  <div className="order-main">
                    <div className="order-top">
                      <span className="mono muted">#{o.id.slice(0, 8)}</span>
                      <StatusBadge status={o.status} />
                    </div>
                    <div className="order-items">
                      {o.items.map((i) => `${i.quantity}× ${i.name}`).join(" · ")}
                    </div>
                    <div className="order-meta">
                      <span className="mono muted">cust {o.customer_id.slice(0, 8)}</span>
                      <strong>{money(o.total_cents)}</strong>
                    </div>
                  </div>
                  {o.status === "PLACED" && (
                    <div className="order-actions">
                      <button
                        className="btn btn-success btn-sm"
                        onClick={() => handleOrderStatus(o.id, "READY")}
                      >
                        Ready
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleOrderStatus(o.id, "CANCELLED")}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {orders.length === 0 && <Empty>No orders yet</Empty>}
            </div>
          </section>
        </div>

        <div className="grid grid-secondary">
          <section className="card">
            <CardHeader
              title="Menu"
              tag="admin"
              hint="Plain CRUD — no outbox involved, it's reference data."
            />
            <form onSubmit={handleAddMenuItem} className="inline-form">
              <input
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder="Item name, e.g. Margherita"
                aria-label="Item name"
                required
              />
              <div className="price-input">
                <span>$</span>
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={newItemPrice}
                  onChange={(e) => setNewItemPrice(e.target.value)}
                  aria-label="Price in dollars"
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary">
                Add
              </button>
            </form>
            <ul className="menu-list">
              {menu.map((item) => (
                <li key={item.id} className={item.is_available ? "" : "unavailable"}>
                  <div className="menu-name">{item.name}</div>
                  <div className="menu-price">{money(item.price_cents)}</div>
                  <button
                    className={`switch ${item.is_available ? "on" : ""}`}
                    onClick={() => handleToggleAvailability(item)}
                    title={item.is_available ? "Available — click to 86 it" : "86'd — click to restore"}
                    aria-pressed={item.is_available}
                  >
                    <span className="switch-knob" />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon danger"
                    onClick={() => handleDeleteMenuItem(item.id)}
                    title="Delete item"
                    aria-label={`Delete ${item.name}`}
                  >
                    🗑
                  </button>
                </li>
              ))}
              {menu.length === 0 && <Empty>No menu items yet</Empty>}
            </ul>
          </section>

          <section className="card">
            <CardHeader
              title="Outbox"
              count={outbox.length}
              hint="The relay polls this table and publishes PENDING rows to the broker."
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Aggregate</th>
                    <th>Status</th>
                    <th className="num">Tries</th>
                    <th className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {outbox.map((e) => (
                    <tr key={e.id}>
                      <td className="event-name">{e.event_type}</td>
                      <td className="mono muted">{e.aggregate_id.slice(0, 8)}</td>
                      <td>
                        <StatusBadge status={e.status} />
                      </td>
                      <td className="num">{e.attempts}</td>
                      <td className="num muted">
                        {new Date(e.occurred_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {outbox.length === 0 && <Empty>No outbox events yet</Empty>}
            </div>
          </section>
        </div>

        <section className={`card dlq-card ${dlq.length > 0 ? "has-items" : ""}`}>
          <CardHeader
            title="Dead-letter queue"
            count={dlq.length}
            hint="Poison rows land here after repeated publish failures, for human/automation follow-up."
            action={
              dlq.length > 0 && (
                <button className="btn btn-primary btn-sm" onClick={handleReplay}>
                  Replay all
                </button>
              )
            }
          />
          {dlq.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th className="num">Tries</th>
                    <th>Last error</th>
                    <th className="num">Moved</th>
                  </tr>
                </thead>
                <tbody>
                  {dlq.map((row) => (
                    <tr key={row.id}>
                      <td className="event-name">{row.event_type}</td>
                      <td className="num">{row.attempts}</td>
                      <td className="error-text">{row.last_error}</td>
                      <td className="num muted">
                        {new Date(row.moved_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>All clear — nothing dead-lettered ✓</Empty>
          )}
        </section>
      </main>
    </div>
  );
}

function CardHeader({
  title,
  hint,
  count,
  tag,
  action,
}: {
  title: string;
  hint?: ReactNode;
  count?: number;
  tag?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-header">
      <div>
        <h2>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
          {tag && <span className="tag">{tag}</span>}
        </h2>
        {hint && <p className="hint">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status.toLowerCase()}`}>{status.toLowerCase()}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function Pipeline({
  orders,
  pending,
  sent,
  dlq,
}: {
  orders: number;
  pending: number;
  sent: number;
  dlq: number;
}) {
  return (
    <div className="pipeline">
      <Stage step={1} label="Domain write" value={orders} unit="orders" />
      <Arrow />
      <Stage
        step={2}
        label="Outbox"
        value={pending}
        unit="pending"
        tone={pending > 0 ? "warn" : undefined}
      />
      <Arrow />
      <Stage step={3} label="Relay" value="●" unit="polling" tone="active" />
      <Arrow />
      <Stage step={4} label="Kitchen" value={sent} unit="delivered" tone="ok" />
      <div className="pipeline-divider" />
      <Stage
        label="DLQ"
        value={dlq}
        unit="poison"
        tone={dlq > 0 ? "bad" : undefined}
        dashed
      />
    </div>
  );
}

function Stage({
  step,
  label,
  value,
  unit,
  tone,
  dashed,
}: {
  step?: number;
  label: string;
  value: number | string;
  unit: string;
  tone?: "warn" | "ok" | "bad" | "active";
  dashed?: boolean;
}) {
  return (
    <div className={`stage ${tone ?? ""} ${dashed ? "dashed" : ""}`}>
      <div className="stage-label">
        {step && <span className="step">{step}</span>}
        {label}
      </div>
      <div className="stage-value">
        {value} <span>{unit}</span>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <svg className="arrow" width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
