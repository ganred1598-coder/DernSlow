CREATE TABLE IF NOT EXISTS stock_counts (
  id TEXT PRIMARY KEY, count_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','completed','cancelled')),
  note TEXT NOT NULL DEFAULT '', started_by TEXT NOT NULL, completed_by TEXT,
  started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS stock_count_items (
  id TEXT PRIMARY KEY, stock_count_id TEXT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id), product_code TEXT NOT NULL,
  product_name TEXT NOT NULL, unit_name TEXT NOT NULL,
  system_qty INTEGER NOT NULL CHECK(system_qty >= 0), counted_qty INTEGER CHECK(counted_qty >= 0), variance_qty INTEGER,
  UNIQUE(stock_count_id,product_id)
);
CREATE INDEX IF NOT EXISTS stock_counts_status_started ON stock_counts(status,started_at DESC);
CREATE INDEX IF NOT EXISTS stock_count_items_count ON stock_count_items(stock_count_id,product_name);
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES ('stock_count_weekday','1',datetime('now'));
