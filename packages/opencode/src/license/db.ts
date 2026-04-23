import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { homedir } from "node:os"
import { Log } from "../util/log"

const log = Log.create({ service: "license-db" })

const DEFAULT_DEV_PATH = `${homedir()}/.local/share/opencode/licenses.db`

let _db: Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY,
  email           TEXT,
  telegram        TEXT,
  telegram_user_id INTEGER,
  note            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS customers_telegram_idx ON customers(telegram);
CREATE INDEX IF NOT EXISTS customers_telegram_user_id_idx ON customers(telegram_user_id);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  customer_telegram TEXT,
  customer_user_id  INTEGER,
  interval          TEXT NOT NULL CHECK (interval IN ('monthly','annual','lifetime')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  tx_hash           TEXT,
  note              TEXT,
  created_at        INTEGER NOT NULL,
  confirmed_at      INTEGER,
  license_id        TEXT
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(customer_user_id);

CREATE TABLE IF NOT EXISTS licenses (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL,
  order_id          TEXT,
  token_sig         TEXT UNIQUE NOT NULL,
  interval          TEXT NOT NULL CHECK (interval IN ('monthly','annual','lifetime')),
  issued_at         INTEGER NOT NULL,
  expires_at        INTEGER,
  revoked_at        INTEGER,
  revoked_reason    TEXT,
  last_validated_at INTEGER,
  machine_id        TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS licenses_customer_idx ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS licenses_token_sig_idx ON licenses(token_sig);

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  action    TEXT NOT NULL,
  details   TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit(ts DESC);
`

function resolvePath(): string {
  const explicit = process.env.LICENSE_DB_PATH
  if (explicit) return explicit
  return DEFAULT_DEV_PATH
}

export function getDb(): Database {
  if (_db) return _db
  const p = resolvePath()
  const dir = dirname(p)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    log.info("created database directory", { dir })
  }
  log.info("opening license database", { path: p })
  const db = new Database(p, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)
  _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
