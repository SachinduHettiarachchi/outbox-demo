import { useEffect, useState } from "react";
import { api, subscribeKitchenStream, TicketEvent } from "./api";

interface Ticket {
  orderId: string;
  items: { name: string; quantity: number }[];
  placedAt: number;
}

export default function KitchenApp() {
  const [tickets, setTickets] = useState<Record<string, Ticket>>({});
  const [connected, setConnected] = useState(false);

  // Seed with whatever's already PLACED (covers orders placed before this
  // screen connected — the SSE stream only carries events from here on).
  useEffect(() => {
    api.listOrders().then((orders) => {
      const seeded: Record<string, Ticket> = {};
      for (const o of orders) {
        if (o.status === "PLACED") {
          seeded[o.id] = {
            orderId: o.id,
            items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
            placedAt: new Date(o.created_at).getTime(),
          };
        }
      }
      setTickets(seeded);
    });
  }, []);

  useEffect(() => {
    const handle = (event: TicketEvent) => {
      setConnected(true);
      const { orderId, status, items } = event.payload;
      setTickets((prev) => {
        const next = { ...prev };
        if (event.type === "OrderPlaced" && items) {
          next[orderId] = {
            orderId,
            items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
            placedAt: Date.now(),
          };
        } else if (status === "READY" || status === "CANCELLED") {
          delete next[orderId];
        }
        return next;
      });
    };
    const unsubscribe = subscribeKitchenStream(handle);
    return unsubscribe;
  }, []);

  // Re-render every 15s so ticket ages (and their colour) stay current.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  const openTickets = Object.values(tickets).sort((a, b) => a.placedAt - b.placedAt);

  return (
    <div className="kitchen-page">
      <div className="kitchen-header">
        <div>
          <h1>Kitchen Display</h1>
          <p className={`kitchen-status ${connected ? "live" : ""}`}>
            {connected ? "Live — consuming outbox events" : "Waiting for events…"}
          </p>
        </div>
        <div className="kitchen-count">
          <strong>{openTickets.length}</strong>
          <span>open tickets</span>
        </div>
      </div>
      {openTickets.length === 0 ? (
        <div className="ticket-empty">
          <div>🍽</div>
          No open tickets — kitchen is clear
        </div>
      ) : (
        <div className="ticket-board">
          {openTickets.map((t) => {
            const mins = Math.max(0, Math.floor((now - t.placedAt) / 60000));
            const age = mins >= 15 ? "late" : mins >= 8 ? "aging" : "";
            return (
              <div className={`ticket ${age}`} key={t.orderId}>
                <div className="ticket-header">
                  <strong>#{t.orderId.slice(0, 8)}</strong>
                  <span>
                    {new Date(t.placedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {mins}m
                  </span>
                </div>
                <ul>
                  {t.items.map((i, idx) => (
                    <li key={idx}>
                      <span className="qty">{i.quantity}×</span>
                      <span>{i.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
