import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, DlqRow, MenuItem, Order, OutboxEvent } from "./api";

const POLL_MS = 2000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomCustomerId(): string {
  return crypto.randomUUID();
}

export default function App() {
  const [customerId, setCustomerId] = useState(randomCustomerId());
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [newItemName, setNewItemName] = useState("");
  const [newItemPrice, setNewItemPrice] = useState(1000);
  const [orders, setOrders] = useState<Order[]>([]);
  const [outbox, setOutbox] = useState<OutboxEvent[]>([]);
  const [dlq, setDlq] = useState<DlqRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(null);
    } catch (err) {
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

  const selectedItems = Object.entries(quantities).filter(([, qty]) => qty > 0);
  const orderTotalCents = selectedItems.reduce((sum, [menuItemId, qty]) => {
    const item = menu.find((m) => m.id === menuItemId);
    return sum + (item ? item.price_cents * qty : 0);
  }, 0);

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
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddMenuItem(e: FormEvent) {
    e.preventDefault();
    if (!newItemName.trim() || newItemPrice <= 0) return;
    try {
      await api.createMenuItem(newItemName.trim(), newItemPrice);
      setNewItemName("");
      setNewItemPrice(1000);
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
    <div className="page">
      <header>
        <h1>Restaurant Order &amp; Kitchen Display</h1>
        <p className="subtitle">
          Placing an order writes the order + <code>OrderPlaced</code> event
          atomically. Status updates (<code>OrderReady</code>,{" "}
          <code>OrderCancelled</code>) go through the same outbox. See the{" "}
          <a href="/kitchen.html">Kitchen Display</a> for the live ticket
          screen.
        </p>
      </header>

      <Pipeline pending={pendingCount} sent={sentCount} dlq={dlq.length} />

      {error && <div className="banner error">{error}</div>}

      <div className="grid">
        <section className="card">
          <h2>Menu (admin)</h2>
          <p className="hint">Plain CRUD — no outbox involved, it's reference data.</p>
          <form onSubmit={handleAddMenuItem}>
            <label>
              Item name
              <input
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder="e.g. Margherita Pizza"
                required
              />
            </label>
            <label>
              Price (cents)
              <input
                type="number"
                min={1}
                value={newItemPrice}
                onChange={(e) => setNewItemPrice(Number(e.target.value))}
                required
              />
            </label>
            <button type="submit">Add item</button>
          </form>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Price</th>
                <th>Available</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {menu.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>${(item.price_cents / 100).toFixed(2)}</td>
                  <td>
                    <button className="secondary" onClick={() => handleToggleAvailability(item)}>
                      {item.is_available ? "Available" : "86'd"}
                    </button>
                  </td>
                  <td>
                    <button className="secondary" onClick={() => handleDeleteMenuItem(item.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {menu.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No menu items yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Place order</h2>
          <p className="hint">
            Writes to <code>orders</code>, <code>order_items</code> and{" "}
            <code>outbox</code> in one transaction.
          </p>
          <form onSubmit={handleCreateOrder}>
            <label>
              Customer ID
              <input
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                required
              />
            </label>
            {menu
              .filter((m) => m.is_available)
              .map((item) => (
                <label key={item.id} className="item-row">
                  {item.name} (${(item.price_cents / 100).toFixed(2)})
                  <input
                    type="number"
                    min={0}
                    value={quantities[item.id] ?? 0}
                    onChange={(e) =>
                      setQuantities((q) => ({ ...q, [item.id]: Number(e.target.value) }))
                    }
                  />
                </label>
              ))}
            {menu.filter((m) => m.is_available).length === 0 && (
              <p className="hint">Add an available menu item first.</p>
            )}
            <p className="hint">Total: ${(orderTotalCents / 100).toFixed(2)}</p>
            <button type="submit" disabled={submitting}>
              {submitting ? "Placing…" : "Place order"}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Orders</h2>
          <p className="hint">Mark ready or cancel — both write an outbox event.</p>
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.customer_id.slice(0, 8)}…</td>
                  <td>{o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</td>
                  <td>${(o.total_cents / 100).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${o.status.toLowerCase()}`}>{o.status}</span>
                  </td>
                  <td>
                    {o.status === "PLACED" && (
                      <>
                        <button className="secondary" onClick={() => handleOrderStatus(o.id, "READY")}>
                          Ready
                        </button>{" "}
                        <button className="secondary" onClick={() => handleOrderStatus(o.id, "CANCELLED")}>
                          Cancel
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No orders yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Outbox</h2>
          <p className="hint">
            Relay polls this table and publishes PENDING rows to the broker.
          </p>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Aggregate</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Occurred</th>
              </tr>
            </thead>
            <tbody>
              {outbox.map((e) => (
                <tr key={e.id}>
                  <td>{e.event_type}</td>
                  <td className="mono">{e.aggregate_id.slice(0, 8)}…</td>
                  <td>
                    <span className={`badge ${e.status.toLowerCase()}`}>
                      {e.status}
                    </span>
                  </td>
                  <td>{e.attempts}</td>
                  <td>{new Date(e.occurred_at).toLocaleTimeString()}</td>
                </tr>
              ))}
              {outbox.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No outbox events yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Dead-letter queue</h2>
            {dlq.length > 0 && (
              <button className="secondary" onClick={handleReplay}>
                Replay all
              </button>
            )}
          </div>
          <p className="hint">
            Poison rows land here after repeated publish failures, for
            human/automation follow-up.
          </p>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Moved</th>
              </tr>
            </thead>
            <tbody>
              {dlq.map((row) => (
                <tr key={row.id}>
                  <td>{row.event_type}</td>
                  <td>{row.attempts}</td>
                  <td className="error-text">{row.last_error}</td>
                  <td>{new Date(row.moved_at).toLocaleTimeString()}</td>
                </tr>
              ))}
              {dlq.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    Empty — nothing dead-lettered
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Pipeline({
  pending,
  sent,
  dlq,
}: {
  pending: number;
  sent: number;
  dlq: number;
}) {
  return (
    <div className="pipeline">
      <Stage label="Domain write" desc="orders + order_items" />
      <Arrow />
      <Stage label="Outbox row" desc={`${pending} pending`} highlight={pending > 0} />
      <Arrow />
      <Stage label="Relay" desc="polls & publishes" />
      <Arrow />
      <Stage label="Kitchen Display" desc={`${sent} sent`} />
      <Branch label="DLQ" desc={`${dlq} poison`} alert={dlq > 0} />
    </div>
  );
}

function Stage({
  label,
  desc,
  highlight,
}: {
  label: string;
  desc: string;
  highlight?: boolean;
}) {
  return (
    <div className={`stage ${highlight ? "highlight" : ""}`}>
      <div className="stage-label">{label}</div>
      <div className="stage-desc">{desc}</div>
    </div>
  );
}

function Branch({
  label,
  desc,
  alert,
}: {
  label: string;
  desc: string;
  alert?: boolean;
}) {
  return (
    <div className={`branch ${alert ? "alert" : ""}`}>
      <div className="stage-label">{label}</div>
      <div className="stage-desc">{desc}</div>
    </div>
  );
}

function Arrow() {
  return <div className="arrow">→</div>;
}
