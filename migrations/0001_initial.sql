PRAGMA foreign_keys = ON;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO settings(key,value,updated_at) VALUES ('reservation_minutes','40',datetime('now'));

CREATE TABLE customers (
  id TEXT PRIMARY KEY, customer_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  phone TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX customers_phone_unique ON customers(phone) WHERE phone <> '';

CREATE TABLE products (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
  stock_units INTEGER NOT NULL DEFAULT 0 CHECK(stock_units >= 0), unit_name TEXT NOT NULL DEFAULT 'ชิ้น',
  price INTEGER NOT NULL CHECK(price >= 0), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE payment_accounts (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, provider TEXT NOT NULL, account_name TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '', qr_object_key TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id), customer_key TEXT NOT NULL,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
  total INTEGER NOT NULL CHECK(total >= 0), status TEXT NOT NULL,
  payment_status TEXT NOT NULL, payment_method TEXT NOT NULL,
  payment_account_id TEXT, payment_slip_key TEXT NOT NULL DEFAULT '',
  reserved_until TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX orders_customer_key_created ON orders(customer_key,created_at DESC);
CREATE INDEX orders_status_reserved ON orders(status,reserved_until);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id), product_code TEXT NOT NULL,
  product_name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price INTEGER NOT NULL CHECK(unit_price >= 0), total INTEGER NOT NULL CHECK(total >= 0)
);

CREATE TABLE stock_log (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), order_id TEXT,
  change_units INTEGER NOT NULL, balance_units INTEGER NOT NULL CHECK(balance_units >= 0),
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE daily_closings (
  id TEXT PRIMARY KEY, closing_date TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL,
  closed_by TEXT NOT NULL, created_at TEXT NOT NULL
);
