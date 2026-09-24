import { pool } from "./db";
import { listDlqRows, replayAllDlqRows } from "./outboxRepository";

async function list(): Promise<void> {
  const rows = await listDlqRows();
  console.table(rows);
}

async function replay(): Promise<void> {
  // In practice you'd filter this to specific ids once you've fixed the cause.
  const count = await replayAllDlqRows();
  console.log(`Replayed ${count} row(s) back into the outbox.`);
}

const cmd = process.argv[2];
if (cmd === "list") {
  list()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else if (cmd === "replay") {
  replay()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  console.log("Usage: ts-node src/dlqTool.ts <list|replay>");
  process.exit(1);
}
