import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { Log } from "../util/log"
import { getDb } from "./db"
import { claimPendingInvitesForCustomer } from "./teams"
import { notifyNewDeviceSignIn } from "./telegram-notify"

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

  // Notify the customer via Telegram about the new device sign-in so they
  // can spot someone else grabbing a PIN. Fire-and-forget — never block the
  // sign-in on a delivery failure.
  if (customer.telegram_user_id) {
    void notifyNewDeviceSignIn({
      telegram_user_id: customer.telegram_user_id,
      device_label: row.device_label ?? null,
      when: now,
    }).catch(() => undefined)
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

/* ─────────────────────────  Username + password auth  ──────────────────────── */

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/
const PASSWORD_MIN = 8
const PASSWORD_MAX = 256
/** scrypt params — OWASP 2023: N=2^14 keeps hash time <250 ms on a Fly shared-cpu. */
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("hex")
  return { hash, salt }
}

function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
  try {
    const candidate = scryptSync(password, storedSalt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })
    const expected = Buffer.from(storedHash, "hex")
    if (expected.length !== candidate.length) return false
    return timingSafeEqual(expected, candidate)
  } catch {
    return false
  }
}

export interface SignUpInput {
  username: string
  password: string
  /** Optional Telegram handle (with or without leading @). Normalised lowercase. */
  telegram?: string | null
  /** Optional email. */
  email?: string | null
  /** Device description shown in the sessions list. */
  device_label?: string | null
}

export interface AuthenticatedSession {
  token: string
  exp: number
  customer_id: string
}

function newCustomerId(): string {
  return "cus_" + b64urlEncode(randomBytes(9))
}

export function signUpWithPassword(input: SignUpInput): AuthenticatedSession {
  if (!USERNAME_RE.test(input.username)) {
    throw new Error("invalid_username")
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < PASSWORD_MIN ||
    input.password.length > PASSWORD_MAX
  ) {
    throw new Error("invalid_password")
  }
  const db = getDb()

  // Is this username already in use by an active account?
  const existing = db
    .prepare<{ customer_id: string }, [string]>(
      "SELECT customer_id FROM password_accounts WHERE username = ? COLLATE NOCASE AND revoked_at IS NULL LIMIT 1",
    )
    .get(input.username)
  if (existing) throw new Error("username_taken")

  const tg = input.telegram ? normalizeTelegram(input.telegram) : null
  const email = input.email ? input.email.trim().toLowerCase() : null

  // If a telegram handle is provided and a customer already has it, reuse
  // that customer row — so signing up later with the same handle you used
  // in the bot links the two identities instead of creating a ghost.
  let customerId: string | null = null
  if (tg) {
    const match = db
      .prepare<{ id: string }, [string]>("SELECT id FROM customers WHERE LOWER(telegram) = ? LIMIT 1")
      .get(tg)
    if (match) customerId = match.id
  }

  const now = Math.floor(Date.now() / 1000)
  const { hash, salt } = hashPassword(input.password)

  db.transaction(() => {
    if (!customerId) {
      customerId = newCustomerId()
      db.prepare(
        "INSERT INTO customers (id, email, telegram, telegram_user_id, note, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
      ).run(customerId, email, tg, "signup via web/desktop", now)
    } else {
      // Optionally enrich the existing row with the email we were just given.
      if (email) {
        db.prepare("UPDATE customers SET email = COALESCE(email, ?) WHERE id = ?").run(email, customerId)
      }
    }
    db.prepare(
      "INSERT INTO password_accounts (customer_id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(customerId, input.username, hash, salt, now)
  })()

  // Issue the session + claim pending invites (if signup brought in a
  // telegram handle that had invites waiting for it).
  const sid = newSessionId()
  db.prepare(
    "INSERT INTO auth_sessions (id, customer_id, created_at, last_seen_at, device_label) VALUES (?, ?, ?, ?, ?)",
  ).run(sid, customerId!, now, now, input.device_label ?? "web/desktop (signup)")

  try {
    claimPendingInvitesForCustomer(customerId!)
  } catch (err) {
    log.warn("failed to claim invites on signup", {
      customer: customerId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const { token, exp } = makeSessionToken({
    sub: customerId!,
    tg: null,
    sid,
  })
  return { token, exp, customer_id: customerId! }
}

export interface SignInInput {
  username: string
  password: string
  device_label?: string | null
}

export function signInWithPassword(input: SignInInput): AuthenticatedSession {
  if (!input.username || !input.password) throw new Error("missing_credentials")
  const db = getDb()
  const row = db
    .prepare<
      { customer_id: string; password_hash: string; password_salt: string; revoked_at: number | null },
      [string]
    >(
      "SELECT customer_id, password_hash, password_salt, revoked_at FROM password_accounts WHERE username = ? COLLATE NOCASE LIMIT 1",
    )
    .get(input.username)
  // Always burn some CPU so wrong-username and wrong-password take similar time.
  if (!row) {
    scryptSync(input.password, "dummy-salt-1234567890abcdef", SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })
    throw new Error("invalid_credentials")
  }
  if (row.revoked_at) throw new Error("account_revoked")
  if (!verifyPassword(input.password, row.password_hash, row.password_salt)) {
    throw new Error("invalid_credentials")
  }

  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE password_accounts SET last_login_at = ? WHERE customer_id = ?").run(now, row.customer_id)

  const customer = db
    .prepare<{ telegram_user_id: number | null }, [string]>("SELECT telegram_user_id FROM customers WHERE id = ?")
    .get(row.customer_id)

  const sid = newSessionId()
  db.prepare(
    "INSERT INTO auth_sessions (id, customer_id, created_at, last_seen_at, device_label) VALUES (?, ?, ?, ?, ?)",
  ).run(sid, row.customer_id, now, now, input.device_label ?? "web/desktop (signin)")

  try {
    claimPendingInvitesForCustomer(row.customer_id)
  } catch {
    /* ignore */
  }

  const { token, exp } = makeSessionToken({
    sub: row.customer_id,
    tg: customer?.telegram_user_id ?? null,
    sid,
  })

  if (customer?.telegram_user_id) {
    void notifyNewDeviceSignIn({
      telegram_user_id: customer.telegram_user_id,
      device_label: input.device_label ?? null,
      when: now,
    }).catch(() => undefined)
  }

  return { token, exp, customer_id: row.customer_id }
}

export interface AccountRow {
  customer_id: string
  username: string
  created_at: number
  last_login_at: number | null
  revoked_at: number | null
  telegram: string | null
  email: string | null
}

export function listPasswordAccounts(limit = 200): AccountRow[] {
  return getDb()
    .prepare<AccountRow, [number]>(
      `SELECT pa.customer_id, pa.username, pa.created_at, pa.last_login_at, pa.revoked_at,
              c.telegram, c.email
         FROM password_accounts pa
         LEFT JOIN customers c ON c.id = pa.customer_id
        ORDER BY pa.created_at DESC
        LIMIT ?`,
    )
    .all(limit)
}

export function revokePasswordAccount(customerId: string): boolean {
  const r = getDb()
    .prepare("UPDATE password_accounts SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL")
    .run(Math.floor(Date.now() / 1000), customerId)
  return r.changes > 0
}

function normalizeTelegram(raw: string): string {
  const trimmed = raw.trim()
  const withAt = trimmed.startsWith("@") ? trimmed : "@" + trimmed
  return withAt.toLowerCase()
}
