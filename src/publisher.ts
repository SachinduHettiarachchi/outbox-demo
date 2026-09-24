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
 * Default publisher used by the demo: just logs. Set SIMULATE_FAILURES=true
 * in .env to randomly throw, so you can watch the relay's retry/backoff/DLQ
 * logic kick in without needing a real broker.
 */
export class ConsolePublisher implements Publisher {
  async publish(topic: string, event: OutboundEvent): Promise<void> {
    if (process.env.SIMULATE_FAILURES === "true" && Math.random() < 0.25) {
      throw new Error("Simulated broker failure");
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
