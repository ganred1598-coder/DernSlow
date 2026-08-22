ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS customers_active_updated ON customers(active,updated_at DESC);
