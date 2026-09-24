import { pool } from "./db";
import { ConsolePublisher, Publisher } from "./publisher";

const BATCH_SIZE = 20;
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_SECONDS = 300; // 5 min cap

interface OutboxRow {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

export class OutboxRelay {
  private running = false;

  constructor(private publisher: Publisher = new ConsolePublisher()) {}

  start(): void {
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.processBatch();
      } catch (err) {
        console.error("[relay] batch failed:", err);
      }
      if (processed === 0) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  /**
   * Locks a batch of pending rows (SKIP LOCKED so multiple relay instances
   * don't collide), publishes each, and commits status changes in the same
   * transaction that held the lock. Ordering guarantee: at most one event per
   * aggregate_id is processed per batch, so event N+1 for an aggregate is
   * never sent before event N has succeeded (matches "one writer per
   * aggregate" from the design).
   */
  private async processBatch(): Promise<number> {
    const client = await pool.connect();
    let processed = 0;
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<OutboxRow>(
        `SELECT id, aggregate_id, aggregate_type, event_type, payload, occurred_at, attempts
         FROM outbox
         WHERE status = 'PENDING' AND next_attempt_at <= now()
         ORDER BY occurred_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );

      const seenAggregates = new Set<string>();
      const toProcess = rows.filter((r) => {
        if (seenAggregates.has(r.aggregate_id)) return false;
        seenAggregates.add(r.aggregate_id);
        return true;
      });

      for (const row of toProcess) {
        processed++;
        try {
          await this.publisher.publish(row.aggregate_type, {
            id: row.id,
            type: row.event_type,
            payload: row.payload,
          });
          await client.query(`UPDATE outbox SET status = 'SENT' WHERE id = $1`, [
            row.id,
          ]);
        } catch (err) {
          await this.handleFailure(client, row, err);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return processed;
  }

  private async handleFailure(
    client: import("pg").PoolClient,
    row: OutboxRow,
    err: unknown
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);

    if (attempts >= MAX_ATTEMPTS) {
      await client.query(
        `INSERT INTO outbox_dlq (id, aggregate_id, aggregate_type, event_type, payload, occurred_at, attempts, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id,
          row.aggregate_id,
          row.aggregate_type,
          row.event_type,
          row.payload,
          row.occurred_at,
          attempts,
          message,
        ]
      );
      await client.query(`DELETE FROM outbox WHERE id = $1`, [row.id]);
      console.error(
        `[relay] ${row.id} moved to DLQ after ${attempts} attempts: ${message}`
      );
    } else {
      const backoffSeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
      await client.query(
        `UPDATE outbox
         SET attempts = $2,
             next_attempt_at = now() + ($3 || ' seconds')::interval,
             last_error = $4
         WHERE id = $1`,
        [row.id, attempts, backoffSeconds, message]
      );
      console.warn(
        `[relay] ${row.id} retry ${attempts}/${MAX_ATTEMPTS} scheduled in ${backoffSeconds}s: ${message}`
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
