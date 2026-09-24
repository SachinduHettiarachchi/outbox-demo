import { PoolClient } from "pg";
import { pool } from "./db";

export interface NewOutboxEvent {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: unknown;
}

/**
 * Insert an outbox row using the SAME client/transaction as the domain write.
 * This must always be called between a BEGIN and COMMIT that also writes the
 * domain change — that single transaction is the entire trick of this pattern.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  event: NewOutboxEvent
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_id, aggregate_type, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [event.aggregateId, event.aggregateType, event.eventType, event.payload]
  );
}

/** Read-only view of recent outbox rows, newest first — for dashboards/UIs. */
export async function listRecentOutboxEvents(limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, aggregate_id, aggregate_type, event_type, payload, occurred_at,
            status, attempts, next_attempt_at, last_error
     FROM outbox
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Read-only view of dead-lettered (poison) rows. */
export async function listDlqRows() {
  const { rows } = await pool.query(
    `SELECT id, aggregate_id, aggregate_type, event_type, payload, occurred_at,
            attempts, last_error, moved_at
     FROM outbox_dlq
     ORDER BY moved_at DESC`
  );
  return rows;
}

/** Moves every DLQ row back into outbox as a fresh PENDING attempt. */
export async function replayAllDlqRows(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM outbox_dlq`);
    for (const row of rows) {
      await client.query(
        `INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, occurred_at, status, attempts, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 0, now())`,
        [
          row.id,
          row.aggregate_id,
          row.aggregate_type,
          row.event_type,
          row.payload,
          row.occurred_at,
        ]
      );
      await client.query(`DELETE FROM outbox_dlq WHERE id = $1`, [row.id]);
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
