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
  id                   TEXT PRIMARY KEY,
  email                TEXT,
  telegram             TEXT,
  telegram_user_id     INTEGER,
  note                 TEXT,
  created_at           INTEGER NOT NULL,
  -- Approval gate: new signups land here as 'pending' until the admin
  -- clicks Approve in the bot or the admin panel. Only then does the
  -- trial start and a session token get issued. Existing rows default
  -- to 'approved' via the migration so current users keep working.
  approval_status      TEXT NOT NULL DEFAULT 'approved',
  approved_at          INTEGER,
  approved_by          TEXT,           -- 'admin-panel' | 'bot:<chat_id>' | 'auto'
  approved_trial_days  INTEGER,        -- trial length chosen at approval time (e.g. 2 or 7)
  rejected_reason      TEXT
);
CREATE INDEX IF NOT EXISTS customers_telegram_idx ON customers(telegram);
CREATE INDEX IF NOT EXISTS customers_telegram_user_id_idx ON customers(telegram_user_id);
CREATE INDEX IF NOT EXISTS customers_approval_idx ON customers(approval_status, created_at);

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

-- Classic username + password accounts, for users who don't want to sign
-- in via Telegram. One row per customer; the customer row continues to
-- hold optional telegram handle, email, etc.
CREATE TABLE IF NOT EXISTS password_accounts (
  customer_id    TEXT PRIMARY KEY,
  username       TEXT NOT NULL COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  revoked_at     INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS password_accounts_username_unique
  ON password_accounts(username COLLATE NOCASE)
  WHERE revoked_at IS NULL;

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

-- Teams: one owner + N members sharing a workspace with live session metadata.
CREATE TABLE IF NOT EXISTS teams (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  owner_customer_id   TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (owner_customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS teams_owner_idx ON teams(owner_customer_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id      TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (team_id, customer_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS team_members_customer_idx ON team_members(customer_id);

-- Pending invites — claimed when the invitee signs in and their Telegram
-- handle or email matches. The invite is then deleted.
CREATE TABLE IF NOT EXISTS team_invites (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  identifier   TEXT NOT NULL,           -- @telegramhandle or email
  role         TEXT NOT NULL DEFAULT 'member',
  invited_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_invites_team_idx ON team_invites(team_id);
CREATE INDEX IF NOT EXISTS team_invites_identifier_idx ON team_invites(identifier);

-- Live sessions advertised by a team member to the rest of the team.
-- "state" is a JSON blob the client owns (project path, current file, etc).
CREATE TABLE IF NOT EXISTS team_sessions (
  id                 TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL,
  host_customer_id   TEXT NOT NULL,
  title              TEXT NOT NULL,
  state              TEXT,
  created_at         INTEGER NOT NULL,
  last_heartbeat_at  INTEGER NOT NULL,
  ended_at           INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (host_customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS team_sessions_team_idx ON team_sessions(team_id, ended_at);
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
    // v2.21.0: admin-approval gate for new accounts. Existing customers
    // default to 'approved' so current users are not locked out.
    [
      "v2.customers.approval_status",
      "ALTER TABLE customers ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'",
    ],
    ["v2.customers.approved_at", "ALTER TABLE customers ADD COLUMN approved_at INTEGER"],
    ["v2.customers.approved_by", "ALTER TABLE customers ADD COLUMN approved_by TEXT"],
    ["v2.customers.approved_trial_days", "ALTER TABLE customers ADD COLUMN approved_trial_days INTEGER"],
    ["v2.customers.rejected_reason", "ALTER TABLE customers ADD COLUMN rejected_reason TEXT"],
    [
      "v2.customers.approval_idx",
      "CREATE INDEX IF NOT EXISTS customers_approval_idx ON customers(approval_status, created_at)",
    ],
    // v2.22.21: referral system. Each customer gets a short shareable
    // code on demand; when a brand-new signup uses that code, both
    // sides earn extra trial days. The codes table holds the slug;
    // the claims table records who referred whom and whether the bonus
    // has already been credited (so the same referrer/referred pair
    // can't be claimed twice).
    [
      "v3.referral_codes",
      `CREATE TABLE IF NOT EXISTS referral_codes (
         code            TEXT PRIMARY KEY,
         customer_id     TEXT NOT NULL,
         created_at      INTEGER NOT NULL,
         FOREIGN KEY (customer_id) REFERENCES customers(id)
       )`,
    ],
    [
      "v3.referral_codes_customer_idx",
      "CREATE INDEX IF NOT EXISTS referral_codes_customer_idx ON referral_codes(customer_id)",
    ],
    [
      "v3.referral_claims",
      `CREATE TABLE IF NOT EXISTS referral_claims (
         id                       INTEGER PRIMARY KEY AUTOINCREMENT,
         code                     TEXT NOT NULL,
         referrer_customer_id     TEXT NOT NULL,
         referred_customer_id     TEXT NOT NULL,
         claimed_at               INTEGER NOT NULL,
         referrer_bonus_days      INTEGER NOT NULL,
         referred_bonus_days      INTEGER NOT NULL,
         UNIQUE (referrer_customer_id, referred_customer_id),
         FOREIGN KEY (referrer_customer_id) REFERENCES customers(id),
         FOREIGN KEY (referred_customer_id) REFERENCES customers(id)
       )`,
    ],
    [
      "v3.referral_claims_referrer_idx",
      "CREATE INDEX IF NOT EXISTS referral_claims_referrer_idx ON referral_claims(referrer_customer_id, claimed_at DESC)",
    ],
    // v2.22.23: referral bonus accounting. When a referral is claimed at
    // signup the bonus days can't always be applied immediately — the new
    // customer is "pending" and has no active license/trial yet. We park
    // the bonus on the customer row and consume it at approval time so
    // the trial that gets handed out includes the bonus baked in.
    // `referrer_bonus_days_credited` tracks how many days have already
    // been pushed onto the referrer's active license (or queued as
    // pending) — prevents double-credit on multiple replays.
    [
      "v3.customers.pending_referral_days",
      "ALTER TABLE customers ADD COLUMN pending_referral_days INTEGER NOT NULL DEFAULT 0",
    ],
    [
      "v3.customers.referral_code_used",
      "ALTER TABLE customers ADD COLUMN referral_code_used TEXT",
    ],
    [
      "v3.referral_claims.referrer_credited_at",
      "ALTER TABLE referral_claims ADD COLUMN referrer_credited_at INTEGER",
    ],
    [
      "v3.referral_claims.referred_credited_at",
      "ALTER TABLE referral_claims ADD COLUMN referred_credited_at INTEGER",
    ],
    // v2.22.25: track in-progress payments. Before this, payment_offers
    // only flipped from "open" → "matched_tx_hash IS NOT NULL" when the
    // tx hit minConfirmations. The user got a single message at issuance
    // and nothing in between — bad UX for slow chains. We now record:
    //   * seen_tx_hash       — first tx that matched the expected amount
    //   * seen_at            — when we first detected it
    //   * seen_confirmations — last polled conf count (lets /status show progress)
    //   * notified_seen_at   — gates the "payment received, awaiting confirmations"
    //                          notification so it only fires once per offer
    [
      "v3.payment_offers.seen_tx_hash",
      "ALTER TABLE payment_offers ADD COLUMN seen_tx_hash TEXT",
    ],
    [
      "v3.payment_offers.seen_at",
      "ALTER TABLE payment_offers ADD COLUMN seen_at INTEGER",
    ],
    [
      "v3.payment_offers.seen_confirmations",
      "ALTER TABLE payment_offers ADD COLUMN seen_confirmations INTEGER",
    ],
    [
      "v3.payment_offers.notified_seen_at",
      "ALTER TABLE payment_offers ADD COLUMN notified_seen_at INTEGER",
    ],
    // v2.22.47: real-time team chat. Messages persist for the last
    // 200 entries per team so that members joining a workspace can
    // scroll back to recent context. The pruning happens on insert,
    // so we keep the table indexed by (team_id, ts DESC).
    [
      "v4.team_chat_messages",
      `CREATE TABLE IF NOT EXISTS team_chat_messages (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         team_id       TEXT NOT NULL,
         customer_id   TEXT NOT NULL,
         author_name   TEXT,
         text          TEXT NOT NULL,
         ts            INTEGER NOT NULL,
         FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
         FOREIGN KEY (customer_id) REFERENCES customers(id)
       )`,
    ],
    [
      "v4.team_chat_messages_team_ts_idx",
      "CREATE INDEX IF NOT EXISTS team_chat_messages_team_ts_idx ON team_chat_messages(team_id, ts DESC)",
    ],
    // v2.23.3: team invite links. Owner/admin generates a shareable URL with
    // a random token; recipients click it and auto-join with the encoded role.
    // Token is opaque (URL-safe base64) and stored verbatim — no hashing,
    // since invite tokens are inherently meant to be shared and we already
    // gate redemption with the customer's authenticated session.
    [
      "v5.team_invite_links",
      `CREATE TABLE IF NOT EXISTS team_invite_links (
         token         TEXT PRIMARY KEY,
         team_id       TEXT NOT NULL,
         role          TEXT NOT NULL DEFAULT 'member',
         created_by    TEXT NOT NULL,
         created_at    INTEGER NOT NULL,
         expires_at    INTEGER,
         max_uses      INTEGER,
         uses          INTEGER NOT NULL DEFAULT 0,
         revoked_at    INTEGER,
         FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
         FOREIGN KEY (created_by) REFERENCES customers(id)
       )`,
    ],
    [
      "v5.team_invite_links_team_idx",
      "CREATE INDEX IF NOT EXISTS team_invite_links_team_idx ON team_invite_links(team_id, created_at DESC)",
    ],
    // v2.23.3: chat attachments. Renderer uploads images/PDFs to R2 and
    // posts the resulting URL alongside the message. Stored as nullable
    // columns so existing chat rows aren't affected.
    ["v5.team_chat_messages.attachment_url", "ALTER TABLE team_chat_messages ADD COLUMN attachment_url TEXT"],
    ["v5.team_chat_messages.attachment_type", "ALTER TABLE team_chat_messages ADD COLUMN attachment_type TEXT"],
    ["v5.team_chat_messages.attachment_size", "ALTER TABLE team_chat_messages ADD COLUMN attachment_size INTEGER"],
    ["v5.team_chat_messages.attachment_name", "ALTER TABLE team_chat_messages ADD COLUMN attachment_name TEXT"],
    // v2.23.3: extend role CHECK to include 'viewer'. SQLite cannot ALTER a
    // CHECK constraint in place, so we rebuild the table. Idempotent —
    // if v6 marker already ran on this DB, the CREATE IF NOT EXISTS at
    // boot uses the new schema and this rename becomes a no-op.
    [
      "v6.team_members_viewer_role",
      `BEGIN;
       CREATE TABLE IF NOT EXISTS team_members_v6 (
         team_id      TEXT NOT NULL,
         customer_id  TEXT NOT NULL,
         role         TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
         added_at     INTEGER NOT NULL,
         PRIMARY KEY (team_id, customer_id),
         FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
         FOREIGN KEY (customer_id) REFERENCES customers(id)
       );
       INSERT INTO team_members_v6 SELECT team_id, customer_id, role, added_at FROM team_members;
       DROP TABLE team_members;
       ALTER TABLE team_members_v6 RENAME TO team_members;
       CREATE INDEX IF NOT EXISTS team_members_customer_idx ON team_members(customer_id);
       COMMIT;`,
    ],
    // v2.26.0: read receipts. One row per (team, customer) tracking the
    // highest message_id they've acknowledged. Updated on POST /chat/read.
    [
      "v7.team_chat_reads",
      `CREATE TABLE IF NOT EXISTS team_chat_reads (
         team_id              TEXT NOT NULL,
         customer_id          TEXT NOT NULL,
         last_read_message_id INTEGER NOT NULL,
         updated_at           INTEGER NOT NULL,
         PRIMARY KEY (team_id, customer_id),
         FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
         FOREIGN KEY (customer_id) REFERENCES customers(id)
       )`,
    ],
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
