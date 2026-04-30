/**
 * License authentication — PIN-based Telegram magic-link flow.
 * Self-contained copy of the auth logic from packages/opencode/src/license/auth.ts
 * so that crimeopus-api can serve /license/auth/* without depending on opencode.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { homedir } from "node:os"

// ─── License database connection ──────────────────────────────────────

let _licenseDb: Database | null = null

function resolveLicenseDbPath(): string {
  const explicit = process.env.LICENSE_DB_PATH
  if (explicit) return explicit
  return `${homedir()}/.local/share/opencode/licenses.db`
}

const LICENSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id                   TEXT PRIMARY KEY,
  email                TEXT,
  telegram             TEXT,
  telegram_user_id     INTEGER,
  note                 TEXT,
  created_at           INTEGER NOT NULL,
  approval_status      TEXT NOT NULL DEFAULT 'approved',
  approved_at          INTEGER,
  approved_by          TEXT,
  approved_trial_days  INTEGER,
  rejected_reason      TEXT
);
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
`

export function getLicenseDb(): Database {
  if (_licenseDb) return _licenseDb
  const p = resolveLicenseDbPath()
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(p, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(LICENSE_SCHEMA)
  _licenseDb = db
  return _licenseDb
}

// ─── Session token (HMAC-signed) ──────────────────────────────────────

const SESSION_TTL_SEC = 30 * 24 * 60 * 60

function getSecret(): Buffer {
  const raw = process.env.LICENSE_HMAC_SECRET
  if (!raw || raw.length < 32) throw new Error("LICENSE_HMAC_SECRET must be set (>= 32 chars)")
  return Buffer.from(raw, "utf8")
}

function b64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  return Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + pad, "base64")
}

function sign(payloadB64: string, secret: Buffer): string {
  return b64urlEncode(createHmac("sha256", secret).update(payloadB64).digest()).slice(0, 22)
}

interface SessionPayload {
  sub: string
  tg: number | null
  iat: number
  exp: number
  sid: string
}

export function makeSessionToken(payload: { sub: string; tg: number | null; sid: string; ttlSec?: number }): {
  token: string
  exp: number
} {
  const secret = getSecret()
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + (payload.ttlSec ?? SESSION_TTL_SEC)
  const full: SessionPayload = { sub: payload.sub, tg: payload.tg, sid: payload.sid, iat, exp }
  const json = JSON.stringify(full)
  const payloadB64 = b64urlEncode(Buffer.from(json, "utf8"))
  const sig = sign(payloadB64, secret)
  return { token: `S1.${payloadB64}.${sig}`, exp }
}

/**
 * Verify the token cryptographically (HMAC + expiry) WITHOUT hitting the DB.
 * Use this when you have your own DB handle and want to do the session
 * lookup separately (e.g. in the user-auth middleware).
 */
export function verifyTokenCrypto(
  token: string,
): { ok: true; payload: SessionPayload } | { ok: false; reason: string } {
  if (!token.startsWith("S1.")) return { ok: false, reason: "bad_prefix" }
  const parts = token.slice(3).split(".")
  if (parts.length !== 2) return { ok: false, reason: "bad_format" }
  const [payloadB64, sig] = parts as [string, string]
  let secret: Buffer
  try {
    secret = getSecret()
  } catch {
    return { ok: false, reason: "no_secret" }
  }
  const expected = sign(payloadB64, secret)
  if (expected.length !== sig.length) return { ok: false, reason: "bad_sig_len" }
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return { ok: false, reason: "bad_sig" }
  let payload: SessionPayload
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as SessionPayload
  } catch {
    return { ok: false, reason: "bad_payload" }
  }
  if (!payload.sub || !payload.sid) return { ok: false, reason: "missing_fields" }
  if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" }
  return { ok: true, payload }
}

/**
 * Full verification: crypto + DB session lookup against the production license DB.
 */
export function verifySessionToken(
  token: string,
): { ok: true; payload: SessionPayload } | { ok: false; reason: string } {
  const result = verifyTokenCrypto(token)
  if (!result.ok) return result
  const row = getLicenseDb()
    .prepare<
      { id: string; revoked_at: number | null },
      [string]
    >("SELECT id, revoked_at FROM auth_sessions WHERE id = ?")
    .get(result.payload.sid)
  if (!row) return { ok: false, reason: "session_not_found" }
  if (row.revoked_at) return { ok: false, reason: "session_revoked" }
  return { ok: true, payload: result.payload }
}

// ─── PIN flow ─────────────────────────────────────────────────────────

const PIN_TTL_SEC = 10 * 60
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function randomPin(): string {
  const bytes = randomBytes(8)
  let s = ""
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length]
  return s
}

function newSessionId(): string {
  return "ses_" + b64urlEncode(randomBytes(9))
}

export interface StartedAuth {
  pin: string
  expires_at: number
  bot_url: string
}

export function startAuth(opts: { device_label?: string | null }): StartedAuth {
  const db = getLicenseDb()
  const pin = randomPin()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    "INSERT INTO auth_pins (pin, customer_id, created_at, expires_at, device_label) VALUES (?, NULL, ?, ?, ?)",
  ).run(pin, now, now + PIN_TTL_SEC, opts.device_label ?? null)
  return {
    pin,
    expires_at: now + PIN_TTL_SEC,
    bot_url: `https://t.me/CrimeCodeSub_bot?start=auth_${pin}`,
  }
}

export interface PollResult {
  status: "pending" | "ok" | "expired" | "unknown" | "awaiting_approval" | "rejected"
  token?: string
  exp?: number
  customer_id?: string
  rejected_reason?: string | null
}

export function pollAuth(pin: string): PollResult {
  const db = getLicenseDb()
  const row = db
    .prepare<
      {
        pin: string
        customer_id: string | null
        created_at: number
        expires_at: number
        claimed_at: number | null
        device_label: string | null
      },
      [string]
    >("SELECT * FROM auth_pins WHERE pin = ?")
    .get(pin)
  if (!row) return { status: "unknown" }
  const now = Math.floor(Date.now() / 1000)
  if (!row.claimed_at && row.expires_at <= now) return { status: "expired" }
  if (!row.customer_id || !row.claimed_at) return { status: "pending" }

  const customer = db
    .prepare<
      { id: string; telegram_user_id: number | null; approval_status: string; rejected_reason: string | null },
      [string]
    >("SELECT id, telegram_user_id, approval_status, rejected_reason FROM customers WHERE id = ?")
    .get(row.customer_id)
  if (!customer) return { status: "unknown" }

  if (customer.approval_status === "pending") {
    return { status: "awaiting_approval", customer_id: customer.id }
  }
  if (customer.approval_status === "rejected") {
    db.prepare("DELETE FROM auth_pins WHERE pin = ?").run(pin)
    return { status: "rejected", customer_id: customer.id, rejected_reason: customer.rejected_reason ?? null }
  }

  const sid = newSessionId()
  db.prepare(
    "INSERT INTO auth_sessions (id, customer_id, created_at, last_seen_at, device_label) VALUES (?, ?, ?, ?, ?)",
  ).run(sid, customer.id, now, now, row.device_label ?? null)

  db.prepare("DELETE FROM auth_pins WHERE pin = ?").run(pin)

  const { token, exp } = makeSessionToken({
    sub: customer.id,
    tg: customer.telegram_user_id,
    sid,
  })
  return { status: "ok", token, exp, customer_id: customer.id }
}

export function touchSession(sid: string): void {
  getLicenseDb()
    .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(Math.floor(Date.now() / 1000), sid)
}

// ─── Rate limiter ─────────────────────────────────────────────────────

interface RateWindow {
  count: number
  resetAt: number
}
const rateWindows = new Map<string, RateWindow>()

export function checkRateLimit(
  key: string,
  opts: { max?: number; windowSec?: number } = {},
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const max = opts.max ?? 10
  const windowSec = opts.windowSec ?? 60
  const now = Date.now()
  let w = rateWindows.get(key)
  if (!w || now > w.resetAt) {
    w = { count: 0, resetAt: now + windowSec * 1000 }
    rateWindows.set(key, w)
  }
  w.count++
  if (w.count > max) {
    const retryAfterSec = Math.ceil((w.resetAt - now) / 1000)
    return { ok: false, retryAfterSeconds: retryAfterSec }
  }
  return { ok: true }
}
