import { EventEmitter } from "events";
import { OutboundEvent } from "./publisher";

// Stand-in for a real broker's subscription API. The relay publishes here via
// ConsolePublisher; the Kitchen Display Service (SSE route in server.ts)
// subscribes and pushes tickets to the browser in real time.
export const kitchenEvents = new EventEmitter();
kitchenEvents.setMaxListeners(50);

export function broadcastTicket(event: OutboundEvent): void {
  kitchenEvents.emit("ticket", event);
}
