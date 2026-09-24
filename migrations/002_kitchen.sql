-- Menu items: admin-managed catalog. Not part of the outbox — only order
-- state changes (placed/ready/cancelled) are events.
CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Line items for an order. Name/price are snapshotted at order time so a
-- later menu edit (or delete) never changes a past order's ticket/total.
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);

-- Orders now flow PLACED -> READY or PLACED -> CANCELLED (kitchen workflow),
-- replacing the old generic 'CREATED' default.
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'PLACED';
