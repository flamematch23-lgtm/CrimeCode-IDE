/**
 * SQLite schema + helpers shared by every module.
 *
 * Tables:
 *   usage       — append-only log, one row per request (existing)
 *   keys        — tenant + API key registry (NEW)
 *   quota_period — per-key monthly counters with reset_at (NEW)
 *   webhooks    — admin-managed webhook subscriptions (NEW)
 *
 * The DB file path is taken from $LOG_DB (default ./usage.db). It's the
 * same file we used in v0.1 — quotas and keys are additive.
 */
import { Database } from "bun:sqlite"

let _db: Database | null = null

export function getDb(): Database {
  if (_db) return _db
  const path = process.env.LOG_DB ?? "./usage.db"
  const db = new Database(path)
  db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_label TEXT,
  ip TEXT,
  model TEXT,
  endpoint TEXT,
  status INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage(key_label);

-- Tenant + key registry. A "key" is one of:
--   1. A static API key string (kind='static', secret = sk-xxx)
--   2. A JWT-issued tenant identity (kind='jwt', secret = NULL,
--      tenant_id derived from the JWT 'sub' claim)
-- Static keys persist across restarts; JWT-derived rows are upserted
-- lazily on first request.
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('static','jwt')),
  label TEXT NOT NULL UNIQUE,           -- human-readable, used in logs
  secret TEXT,                          -- raw bearer token (static only); NULL for jwt
  tenant_id TEXT,                       -- JWT sub or admin-assigned tenant id
  rpm INTEGER,                          -- per-key rpm override (NULL = global default)
  monthly_token_quota INTEGER,          -- NULL = unlimited
  monthly_request_quota INTEGER,        -- NULL = unlimited
  scopes TEXT,                          -- comma-separated, e.g. "models:list,chat,embed,audio"
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  notes TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_secret ON keys(secret) WHERE secret IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id);

-- Per-key per-period counter. Period is identified by a YYYY-MM string;
-- on first request of a new month the previous row stays for history
-- and we INSERT a new one.
CREATE TABLE IF NOT EXISTS quota_period (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                 -- "2026-04"
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_requests INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL,            -- ms epoch of next month start
  warned_80 INTEGER NOT NULL DEFAULT 0, -- already fired the 80% webhook
  warned_100 INTEGER NOT NULL DEFAULT 0,
  UNIQUE(key_id, period)
);
CREATE INDEX IF NOT EXISTS idx_quota_period ON quota_period(key_id, period);

-- Outbound webhooks. event = '*' = catch-all.
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  event TEXT NOT NULL DEFAULT '*',
  secret TEXT,                          -- hmac-sha256 signature secret
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  description TEXT
);

-- Audit trail of webhook deliveries (success + failures)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  status INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  response_excerpt TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ts ON webhook_deliveries(ts);
`)
  _db = db
  return db
}

// ─── User settings (in licenses.db) ────────────────────────────────

export type UserSettings = { theme: "dark" | "light" | "auto"; language: "it" | "en" }

const DEFAULT_SETTINGS: UserSettings = { theme: "auto", language: "it" }

export function getUserSettings(licenseDb: Database, customerId: string): UserSettings {
  const row = licenseDb
    .query("SELECT theme, language FROM user_settings WHERE customer_id = ?")
    .get(customerId) as UserSettings | null
  return row ?? { ...DEFAULT_SETTINGS }
}

export function upsertUserSettings(
  licenseDb: Database,
  customerId: string,
  patch: Partial<UserSettings>,
): UserSettings {
  const current = getUserSettings(licenseDb, customerId)
  const next: UserSettings = { ...current, ...patch }
  licenseDb.run(
    `INSERT INTO user_settings (customer_id, theme, language, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       theme = excluded.theme,
       language = excluded.language,
       updated_at = excluded.updated_at`,
    customerId,
    next.theme,
    next.language,
    Date.now(),
  )
  return next
}

// ─── Security log (in licenses.db) ─────────────────────────────────

export type SecurityEvent = {
  customerId: string | null
  event: string
  ip: string | null
  userAgent: string | null
  metadata: Record<string, unknown> | null
}

export type SecurityLogRow = {
  id: number
  event: string
  ip: string | null
  user_agent: string | null
  metadata: Record<string, unknown> | null
  created_at: number
}

export function appendSecurityEvent(licenseDb: Database, ev: SecurityEvent): number {
  const result = licenseDb.run(
    `INSERT INTO security_log
       (customer_id, customer_id_snapshot, event, ip, user_agent, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ev.customerId,
    ev.customerId,
    ev.event,
    ev.ip,
    ev.userAgent ? ev.userAgent.slice(0, 200) : null,
    ev.metadata ? JSON.stringify(ev.metadata) : null,
    Date.now(),
  )
  return Number(result.lastInsertRowid)
}

export function getSecurityLog(
  licenseDb: Database,
  customerId: string,
  opts: { limit?: number; before?: number } = {},
): { events: SecurityLogRow[]; next_cursor: number | null } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const beforeClause = opts.before != null ? "AND id < ?" : ""
  const params: unknown[] = [customerId]
  if (opts.before != null) params.push(opts.before)
  params.push(limit + 1) // fetch one extra to detect if there are more

  const rows = licenseDb
    .query(
      `SELECT id, event, ip, user_agent, metadata, created_at
       FROM security_log
       WHERE customer_id_snapshot = ? ${beforeClause}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number
    event: string
    ip: string | null
    user_agent: string | null
    metadata: string | null
    created_at: number
  }>

  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  return {
    events: visible.map((r) => ({
      id: r.id,
      event: r.event,
      ip: r.ip,
      user_agent: r.user_agent,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
      created_at: r.created_at,
    })),
    next_cursor: hasMore ? visible[visible.length - 1].id : null,
  }
}

/** YYYY-MM for the current UTC date — used as quota_period.period key */
export function currentPeriod(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** ms epoch of the start of the next UTC month */
export function nextMonthResetAt(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0)
}
