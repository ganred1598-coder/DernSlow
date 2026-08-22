ALTER TABLE admin_users ADD COLUMN customer_id TEXT REFERENCES customers(id);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_customer_unique ON admin_users(customer_id) WHERE customer_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS admin_invites (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_users(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_invites_active ON admin_invites(code_hash,expires_at) WHERE used_at IS NULL;
