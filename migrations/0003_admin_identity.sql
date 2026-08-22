CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('main_owner','co_owner','admin')),
  commission_percent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_main_owner ON admin_users(role) WHERE role='main_owner' AND active=1;
CREATE TABLE IF NOT EXISTS admin_devices (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_users(id),
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL DEFAULT 'เครื่องหลัก',
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_devices_admin_active ON admin_devices(admin_id,active);
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, admin_name_snapshot TEXT NOT NULL,
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit_log(created_at DESC);