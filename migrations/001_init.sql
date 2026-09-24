-- Needed for gen_random_uuid() on Postgres < 15
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Example domain table. In a real system this is your actual aggregate table(s).
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The outbox itself: one row per domain event, written in the SAME transaction
-- as the domain change that produced it. This is what solves the dual-write problem.
CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SENT
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT
);

-- Relay scans this repeatedly, so the pending queue needs to be a cheap index scan.
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (next_attempt_at)
  WHERE status = 'PENDING';

-- Poison rows land here after MAX_ATTEMPTS, out of the hot path, for human/automation follow-up.
CREATE TABLE IF NOT EXISTS outbox_dlq (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
