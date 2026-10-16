import { broadcastTicket } from "./kitchenBroadcaster";

export interface OutboundEvent {
  id: string;
  type: string;
  payload: unknown;
}

// Swap this interface's implementation for a real broker client
// (Kafka, RabbitMQ, SNS/SQS, etc.) — nothing else in the relay needs to change.
export interface Publisher {
  publish(topic: string, event: OutboundEvent): Promise<void>;
}

/**
 * Default publisher used by the demo: just logs. SIMULATE_FAILURES in .env
 * lets you watch the relay's retry/backoff/DLQ logic without a real broker:
 *   true   — randomly throw on 25% of publishes
 *   poison — always throw for events whose payload mentions "poison" (e.g. an
 *            order containing a menu item named "Poison Pizza"), so a
 *            specific row deterministically ends up in the DLQ
 */
export class ConsolePublisher implements Publisher {
  async publish(topic: string, event: OutboundEvent): Promise<void> {
    const mode = process.env.SIMULATE_FAILURES;
    if (mode === "true" && Math.random() < 0.25) {
      throw new Error("Simulated broker failure");
    }
    if (mode === "poison" && /poison/i.test(JSON.stringify(event.payload))) {
      throw new Error("Simulated poison message: broker rejected payload");
    }
    console.log(
      `[publish] topic=${topic} id=${event.id} type=${event.type} payload=${JSON.stringify(
        event.payload
      )}`
    );
    if (topic === "Order") {
      broadcastTicket(event);
    }
  }
}
