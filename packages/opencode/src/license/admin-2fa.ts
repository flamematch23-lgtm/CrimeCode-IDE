/**
 * Admin TOTP (Time-based One-Time Password) — RFC 6238 / 4226.
 *
 * Two-factor for the /admin BasicAuth gate. When enabled (via setup
 * dance below), every request to /admin must also carry a 6-digit OTP
 * in the `X-Admin-OTP` header (the dashboard prompts for it after the
 * BasicAuth login and stores it in sessionStorage until the tab closes).
 *
 * Zero external deps — RFC 6238 is HMAC-SHA1 of a 64-bit time counter,
 * truncated dynamically to 6 digits. ~30 lines of code.
 *
 * Secret is stored as base32 in app_settings (key admin_totp_secret).
 * Compatible with Google Authenticator / Authy / 1Password / Bitwarden.
 */
import { createHmac, randomBytes } from "node:crypto"
import { getAppSetting, setAppSetting } from "./store"

// ── Base32 (RFC 4648, no padding) ──────────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/[^A-Z2-7]/gi, "").toUpperCase()
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error("invalid base32 character: " + ch)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// ── TOTP RFC 6238 ──────────────────────────────────────────────────────
const STEP = 30 // seconds per code

function counterAt(timestampSec: number): Buffer {
  const counter = Math.floor(timestampSec / STEP)
  // Big-endian 64-bit integer — top 32 bits are zero for any practical
  // unix timestamp until year 2106.
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(0, 0)
  buf.writeUInt32BE(counter, 4)
  return buf
}

function totpAt(secretBase32: string, timestampSec: number): string {
  const key = base32Decode(secretBase32)
  const counter = counterAt(timestampSec)
  const hmac = createHmac("sha1", key).update(counter).digest()
  // Dynamic truncation per RFC 4226 §5.3
  const offset = hmac[hmac.length - 1]! & 0x0f
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)
  return String(code % 1_000_000).padStart(6, "0")
}

/**
 * Verify a 6-digit code with a small clock-skew window (±1 step =
 * ±30s). 1-step window is enough for most clients while still tight
 * enough to make brute-forcing pointless (6 codes × 6 digits = 1M space).
 */
export function verifyTotpCode(secretBase32: string, providedCode: string, windowSteps = 1): boolean {
  if (!/^\d{6}$/.test(providedCode)) return false
  const now = Math.floor(Date.now() / 1000)
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if (totpAt(secretBase32, now + w * STEP) === providedCode) return true
  }
  return false
}

/** Generate a 20-byte random secret (160 bit, RFC 4226 recommended). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * Build the `otpauth://` URL that Google Authenticator / 1Password / Authy
 * scan from a QR code. The QR itself is generated client-side by the
 * dashboard (free QR endpoint api.qrserver.com — same one the licensing
 * payment flow already uses).
 */
export function otpauthUrl(secretBase32: string, label: string, issuer = "CrimeCode Admin"): string {
  const enc = (s: string) => encodeURIComponent(s)
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secretBase32}&issuer=${enc(issuer)}&period=30&digits=6&algorithm=SHA1`
}

// ── App-settings backing ───────────────────────────────────────────────
// Two rows:
//   admin_2fa_enabled  — boolean
//   admin_totp_secret  — base32 string (read-only after enable; rotate
//                        by disabling then re-enabling)

const KEY_ENABLED = "admin_2fa_enabled"
const KEY_SECRET = "admin_totp_secret"

export function is2faEnabled(): boolean {
  return getAppSetting(KEY_ENABLED, false)
}

export function getEnabledSecret(): string | null {
  if (!is2faEnabled()) return null
  const secret = getAppSetting(KEY_SECRET, "")
  return secret || null
}

export function enable2fa(secret: string, firstCode: string, actor: string): { ok: boolean; reason?: string } {
  if (!/^[A-Z2-7]{16,64}$/i.test(secret)) return { ok: false, reason: "invalid_secret" }
  if (!verifyTotpCode(secret, firstCode)) return { ok: false, reason: "wrong_code" }
  setAppSetting(KEY_SECRET, secret.toUpperCase(), actor)
  setAppSetting(KEY_ENABLED, true, actor)
  return { ok: true }
}

export function disable2fa(currentCode: string, actor: string): { ok: boolean; reason?: string } {
  const secret = getEnabledSecret()
  if (!secret) return { ok: false, reason: "not_enabled" }
  if (!verifyTotpCode(secret, currentCode)) return { ok: false, reason: "wrong_code" }
  setAppSetting(KEY_ENABLED, false, actor)
  setAppSetting(KEY_SECRET, "", actor)
  return { ok: true }
}
