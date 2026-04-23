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
  id                      TEXT PRIMARY KEY,
  customer_id             TEXT NOT NULL,
  order_id                TEXT,
  token_sig               TEXT UNIQUE NOT NULL,
  interval                TEXT NOT NULL CHECK (interval IN ('monthly','annual','lifetime')),
  issued_at               INTEGER NOT NULL,
  expires_at              INTEGER,
  revoked_at              INTEGER,
  revoked_reason          TEXT,
  last_validated_at       INTEGER,
  machine_id              TEXT,
  expiry_warning_sent_at  INTEGER,
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

-- Multi-currency payment offers attached to a pending order. One order has
-- 1..N offers (typically 3: BTC, LTC, ETH). The first offer matched on-chain
-- closes the order and emits the license.
CREATE TABLE IF NOT EXISTS payment_offers (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  currency        TEXT NOT NULL CHECK (currency IN ('BTC','LTC','ETH')),
  expected_units  TEXT NOT NULL,           -- BigInt-as-text, smallest unit
  wallet_address  TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  matched_tx_hash TEXT,
  matched_at      INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS payment_offers_order_idx ON payment_offers(order_id);
CREATE INDEX IF NOT EXISTS payment_offers_open_idx ON payment_offers(currency, wallet_address)
  WHERE matched_tx_hash IS NULL;

-- Authentication: short-lived PINs bridge the desktop / web client to a
-- Telegram identity. Client posts /auth/start → gets a PIN → user clicks
-- t.me/CrimeCodeSub_bot?start=auth_<PIN> → bot links the PIN to the
-- customer → client polls /auth/poll/<PIN> → receives a session token.
CREATE TABLE IF NOT EXISTS auth_pins (
  pin           TEXT PRIMARY KEY,
  customer_id   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  claimed_at    INTEGER,
  device_label  TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  device_label  TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS auth_sessions_customer_idx ON auth_sessions(customer_id);

-- Cross-device sync of small JSON blobs (preferences, recent projects, ...).
-- The client owns the schema of "value"; the server is just a key-value store
-- with a per-customer namespace.
CREATE TABLE IF NOT EXISTS sync_kv (
  customer_id   TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (customer_id, key),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
`

function resolvePath(): string {
  const explicit = process.env.LICENSE_DB_PATH
  if (explicit) return explicit
  return DEFAULT_DEV_PATH
}

/**
 * Idempotent ALTER TABLE migrations for schema changes that arrive after the
 * initial CREATE TABLE has already been committed in production. Each entry
 * runs at most once because we wrap it in try/catch — SQLite rejects
 * duplicate-column ALTERs which is exactly what we want.
 */
function runMigrations(db: Database): void {
  const ops: Array<[string, string]> = [
    ["v1.licenses.expiry_warning_sent_at", "ALTER TABLE licenses ADD COLUMN expiry_warning_sent_at INTEGER"],
  ]
  for (const [name, sql] of ops) {
    try {
      db.exec(sql)
      log.info("migration applied", { name })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("duplicate column") || msg.includes("already exists")) continue
      log.warn("migration failed", { name, error: msg })
    }
  }
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
  runMigrations(db)
  _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
