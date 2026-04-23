import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export type Interval = "monthly" | "annual" | "lifetime"

export interface TokenPayload {
  l: string // license id
  i: Interval
  t: number // issued_at (unix seconds)
  e?: number // expires_at (unix seconds, omitted for lifetime)
}

const PREFIX = "CC2-"
const SIG_LEN = 12 // bytes → 16 base64url chars

function getSecret(): Buffer {
  const raw = process.env.LICENSE_HMAC_SECRET
  if (!raw || raw.length < 32) {
    throw new Error("LICENSE_HMAC_SECRET env var must be set (>= 32 chars)")
  }
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
  const h = createHmac("sha256", secret).update(payloadB64).digest()
  return b64urlEncode(h.subarray(0, SIG_LEN))
}

export function makeToken(payload: TokenPayload): { token: string; sig: string } {
  const secret = getSecret()
  const json = JSON.stringify(payload)
  const payloadB64 = b64urlEncode(Buffer.from(json, "utf8"))
  const sig = sign(payloadB64, secret)
  return { token: `${PREFIX}${payloadB64}.${sig}`, sig }
}

export interface VerifyResult {
  ok: boolean
  payload?: TokenPayload
  sig?: string
  reason?: string
}

export function verifyToken(token: string): VerifyResult {
  if (!token.startsWith(PREFIX)) return { ok: false, reason: "bad_prefix" }
  const body = token.slice(PREFIX.length)
  const dot = body.indexOf(".")
  if (dot < 0) return { ok: false, reason: "no_separator" }
  const payloadB64 = body.slice(0, dot)
  const sig = body.slice(dot + 1)
  let secret: Buffer
  try {
    secret = getSecret()
  } catch {
    return { ok: false, reason: "no_secret" }
  }
  const expected = sign(payloadB64, secret)
  if (expected.length !== sig.length) return { ok: false, reason: "bad_sig_length" }
  const eq = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"))
  if (!eq) return { ok: false, reason: "bad_sig" }
  let payload: TokenPayload
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as TokenPayload
  } catch {
    return { ok: false, reason: "bad_payload" }
  }
  if (!payload.l || !payload.i || !payload.t) return { ok: false, reason: "missing_fields" }
  if (!["monthly", "annual", "lifetime"].includes(payload.i)) return { ok: false, reason: "bad_interval" }
  return { ok: true, payload, sig }
}

export function newId(prefix: string): string {
  const bytes = randomBytes(9) // 12 base64 chars
  return `${prefix}_${b64urlEncode(bytes)}`
}

const SECONDS_PER_DAY = 24 * 60 * 60

export function expiryFor(interval: Interval, issuedAt: number): number | undefined {
  if (interval === "lifetime") return undefined
  if (interval === "monthly") return issuedAt + 31 * SECONDS_PER_DAY
  if (interval === "annual") return issuedAt + 366 * SECONDS_PER_DAY
  return undefined
}
