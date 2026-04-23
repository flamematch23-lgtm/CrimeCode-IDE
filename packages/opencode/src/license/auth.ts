import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Log } from "../util/log"
import { getDb } from "./db"
import { claimPendingInvitesForCustomer } from "./teams"

const log = Log.create({ service: "license-auth" })

const PIN_TTL_SEC = 10 * 60 // 10 minutes
const SESSION_TTL_SEC = 30 * 24 * 60 * 60 // 30 days

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

export interface SessionPayload {
  /** customer id */
  sub: string
  /** telegram user id */
  tg: number | null
  /** issued at (unix sec) */
  iat: number
  /** expires at (unix sec) */
  exp: number
  /** session id (one row in DB) */
  sid: string
}

function sign(payloadB64: string, secret: Buffer): string {
  return b64urlEncode(createHmac("sha256", secret).update(payloadB64).digest()).slice(0, 22)
}

export function makeSessionToken(payload: Omit<SessionPayload, "iat" | "exp"> & { ttlSec?: number }): {
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

export interface VerifyOk {
  ok: true
  payload: SessionPayload
}
export interface VerifyErr {
  ok: false
  reason: string
}
export type VerifyResult = VerifyOk | VerifyErr

export function verifySessionToken(token: string): VerifyResult {
  if (!token.startsWith("S1.")) return { ok: false, reason: "bad_prefix" }
  const parts = token.slice(3).split(".")
  if (parts.length !== 2) return { ok: false, reason: "bad_format" }
  const [payloadB64, sig] = parts
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
  // Check the session is still active in DB (allows revoke/logout-everywhere).
  const row = getDb()
    .prepare<{ id: string; revoked_at: number | null }, [string]>(
      "SELECT id, revoked_at FROM auth_sessions WHERE id = ?",
    )
    .get(payload.sid)
  if (!row) return { ok: false, reason: "session_not_found" }
  if (row.revoked_at) return { ok: false, reason: "session_revoked" }
  return { ok: true, payload }
}

/* ─────────────────────────  PIN flow (Telegram bot)  ───────────────────────── */

interface PinRow {
  pin: string
  customer_id: string | null
  created_at: number
  expires_at: number
  claimed_at: number | null
  device_label: string | null
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // unambiguous base32

function randomPin(): string {
  // 8 chars, ~40 bits of entropy. The bot strips this from a deep-link, so
  // length matters less than alphabet — we keep it copy-pasteable.
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
  const db = getDb()
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
  status: "pending" | "ok" | "expired" | "unknown"
  token?: string
  exp?: number
  customer_id?: string
}

export function pollAuth(pin: string): PollResult {
  const db = getDb()
  const row = db
    .prepare<PinRow, [string]>("SELECT * FROM auth_pins WHERE pin = ?")
    .get(pin)
  if (!row) return { status: "unknown" }
  const now = Math.floor(Date.now() / 1000)
  if (!row.claimed_at && row.expires_at <= now) return { status: "expired" }
  if (!row.customer_id || !row.claimed_at) return { status: "pending" }

  // Claimed — load the customer + create a session, return the JWT.
  const customer = db
    .prepare<{ id: string; telegram_user_id: number | null }, [string]>(
      "SELECT id, telegram_user_id FROM customers WHERE id = ?",
    )
    .get(row.customer_id)
  if (!customer) return { status: "unknown" }

  const sid = newSessionId()
  db.prepare(
    "INSERT INTO auth_sessions (id, customer_id, created_at, last_seen_at, device_label) VALUES (?, ?, ?, ?, ?)",
  ).run(sid, customer.id, now, now, row.device_label ?? null)

  // Burn the pin so it can't be reused.
  db.prepare("DELETE FROM auth_pins WHERE pin = ?").run(pin)

  // Auto-accept any pending team invites addressed to this customer's
  // identifiers (Telegram handle / email).
  try {
    claimPendingInvitesForCustomer(customer.id)
  } catch (err) {
    log.warn("failed to claim pending invites", { customer: customer.id, error: err instanceof Error ? err.message : String(err) })
  }

  const { token, exp } = makeSessionToken({
    sub: customer.id,
    tg: customer.telegram_user_id,
    sid,
  })
  return { status: "ok", token, exp, customer_id: customer.id }
}

/** Called from the Telegram bot when a user runs /start auth_<pin>. */
export function claimPinForCustomer(pin: string, customerId: string): { ok: true } | { ok: false; reason: string } {
  const db = getDb()
  const row = db
    .prepare<PinRow, [string]>("SELECT * FROM auth_pins WHERE pin = ?")
    .get(pin)
  if (!row) return { ok: false, reason: "unknown_pin" }
  const now = Math.floor(Date.now() / 1000)
  if (row.expires_at <= now) return { ok: false, reason: "expired" }
  if (row.claimed_at) return { ok: false, reason: "already_claimed" }
  db.prepare("UPDATE auth_pins SET customer_id = ?, claimed_at = ? WHERE pin = ?").run(customerId, now, pin)
  return { ok: true }
}

export function revokeSession(sid: string): boolean {
  const r = getDb()
    .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(Math.floor(Date.now() / 1000), sid)
  return r.changes > 0
}

export function listSessionsForCustomer(customerId: string) {
  return getDb()
    .prepare<
      { id: string; device_label: string | null; created_at: number; last_seen_at: number; revoked_at: number | null },
      [string]
    >(
      `SELECT id, device_label, created_at, last_seen_at, revoked_at
         FROM auth_sessions WHERE customer_id = ? ORDER BY last_seen_at DESC`,
    )
    .all(customerId)
}

export function touchSession(sid: string): void {
  getDb()
    .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(Math.floor(Date.now() / 1000), sid)
}

/* ─────────────────────────  Sync (key-value per account)  ───────────────────── */

export interface SyncEntry {
  key: string
  value: string
  updated_at: number
}

const MAX_KEY_LEN = 80
const MAX_VALUE_BYTES = 64 * 1024 // 64 KB per key — plenty for prefs/recents

export function syncGet(customerId: string, key: string): SyncEntry | null {
  if (key.length > MAX_KEY_LEN) throw new Error("key too long")
  return (
    getDb()
      .prepare<SyncEntry, [string, string]>(
        "SELECT key, value, updated_at FROM sync_kv WHERE customer_id = ? AND key = ?",
      )
      .get(customerId, key) ?? null
  )
}

export function syncList(customerId: string): SyncEntry[] {
  return getDb()
    .prepare<SyncEntry, [string]>(
      "SELECT key, value, updated_at FROM sync_kv WHERE customer_id = ? ORDER BY key",
    )
    .all(customerId)
}

export function syncPut(customerId: string, key: string, value: string): SyncEntry {
  if (key.length > MAX_KEY_LEN) throw new Error("key too long")
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new Error("value too large (max 64KB)")
  const now = Math.floor(Date.now() / 1000)
  const db = getDb()
  db.prepare(
    `INSERT INTO sync_kv (customer_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(customer_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(customerId, key, value, now)
  return { key, value, updated_at: now }
}

export function syncDelete(customerId: string, key: string): boolean {
  const r = getDb().prepare("DELETE FROM sync_kv WHERE customer_id = ? AND key = ?").run(customerId, key)
  return r.changes > 0
}

/* ─────────────────────────  Hashing helper for client-id  ──────────────────── */

export function hashFingerprint(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24)
}
