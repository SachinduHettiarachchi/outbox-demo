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

  const openTickets = Object.values(tickets).sort((a, b) => a.placedAt - b.placedAt);

  return (
    <div className="kitchen-page">
      <div className="kitchen-header">
        <h1>Kitchen Display</h1>
        <p className={`kitchen-status ${connected ? "live" : ""}`}>
          {connected ? "Live — consuming outbox events" : "Waiting for events…"}
        </p>
      </div>
      {openTickets.length === 0 ? (
        <div className="ticket-empty">No open tickets</div>
      ) : (
        <div className="ticket-board">
          {openTickets.map((t) => (
            <div className="ticket" key={t.orderId}>
              <div className="ticket-header">
                <span>#{t.orderId.slice(0, 8)}</span>
                <span>{new Date(t.placedAt).toLocaleTimeString()}</span>
              </div>
              <ul>
                {t.items.map((i, idx) => (
                  <li key={idx}>
                    {i.quantity}× {i.name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
