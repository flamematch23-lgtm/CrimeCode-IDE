CREATE TABLE IF NOT EXISTS security_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_id_snapshot TEXT,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS security_log_customer_idx
  ON security_log(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_log_snapshot_idx
  ON security_log(customer_id_snapshot, created_at DESC);
