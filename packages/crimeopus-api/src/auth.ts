/**
 * Auth resolver — supports three modes (any combination):
 *
 *   1. Static API keys (env API_KEYS, JSON or CSV — preserved from v0.1)
 *      Backed by the `keys` table; on boot we sync env-provided keys
 *      into the table so they show up in the dashboard with usage stats.
 *
 *   2. Database-managed API keys (created via /admin), full per-key
 *      rpm + quota + scopes + label. Treated identically once loaded.
 *
 *   3. JWT bearer tokens. Verified with HS256 against $JWT_SECRET (or
 *      RS256 against $JWT_PUBLIC_KEY). On first request of a new tenant
 *      we INSERT a row in `keys` (kind='jwt', tenant_id=sub) so quota
 *      tracking works the same as for static keys.
 *
 * Returns a normalised `AuthContext` to the request handlers:
 *   { keyId, label, kind, tenantId?, scopes, rpm, quotas }
 */
import { createHmac, createPublicKey, verify } from "node:crypto"
import { getDb } from "./db.ts"

export interface AuthContext {
  keyId: number
  kind: "static" | "jwt"
  label: string
  tenantId: string | null
  rpm: number | null
  monthlyTokenQuota: number | null
  monthlyRequestQuota: number | null
  scopes: Set<string>
}

const DEFAULT_SCOPES = new Set(["models:list", "chat", "embed", "audio", "sandbox"])

interface KeyRow {
  id: number
  kind: "static" | "jwt"
  label: string
  secret: string | null
  tenant_id: string | null
  rpm: number | null
  monthly_token_quota: number | null
  monthly_request_quota: number | null
  scopes: string | null
  disabled: number
}

function rowToContext(r: KeyRow): AuthContext {
  return {
    keyId: r.id,
    kind: r.kind,
    label: r.label,
    tenantId: r.tenant_id,
    rpm: r.rpm,
    monthlyTokenQuota: r.monthly_token_quota,
    monthlyRequestQuota: r.monthly_request_quota,
    scopes: r.scopes ? new Set(r.scopes.split(",").map((s) => s.trim()).filter(Boolean)) : new Set(DEFAULT_SCOPES),
  }
}

/** Sync API_KEYS env into the `keys` table. Idempotent — runs at boot. */
export function syncEnvApiKeys(): void {
  const raw = process.env.API_KEYS ?? ""
  if (!raw) return
  const db = getDb()
  let parsed: Record<string, string | { label: string; rpm?: number; tokenQuota?: number; requestQuota?: number; scopes?: string[] }>
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = Object.fromEntries(
      raw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k) => [k, k.slice(0, 12)] as [string, string]),
    )
  }
  for (const [secret, v] of Object.entries(parsed)) {
    const meta = typeof v === "string" ? { label: v } : v
    const existing = db.query<{ id: number }, [string]>("SELECT id FROM keys WHERE secret = ?").get(secret)
    if (existing) {
      // Refresh metadata from env (env wins over DB tweaks for env-managed keys)
      db.run(
        `UPDATE keys SET label=?, rpm=?, monthly_token_quota=?, monthly_request_quota=?, scopes=?
         WHERE id = ?`,
        [
          meta.label,
          meta.rpm ?? null,
          meta.tokenQuota ?? null,
          meta.requestQuota ?? null,
          meta.scopes?.join(",") ?? null,
          existing.id,
        ],
      )
    } else {
      // Use ON CONFLICT to handle the case where a previous run left a row
      // with the same label (e.g. you rotated the secret but kept the
      // label) — overwrite the metadata + new secret instead of crashing.
      db.run(
        `INSERT INTO keys (kind, label, secret, rpm, monthly_token_quota, monthly_request_quota, scopes, created_at)
         VALUES ('static', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(label) DO UPDATE SET
           secret = excluded.secret,
           rpm = excluded.rpm,
           monthly_token_quota = excluded.monthly_token_quota,
           monthly_request_quota = excluded.monthly_request_quota,
           scopes = excluded.scopes`,
        [
          meta.label,
          secret,
          meta.rpm ?? null,
          meta.tokenQuota ?? null,
          meta.requestQuota ?? null,
          meta.scopes?.join(",") ?? null,
          Date.now(),
        ],
      )
    }
  }
}

/**
 * Resolve a bearer token to an AuthContext.
 *   - Static / DB key:  exact secret match in `keys` table
 *   - JWT:              verify signature, look up (or upsert) keys row
 *                        keyed on `tenant_id = jwt.sub`
 */
export function resolveAuth(bearer: string): AuthContext | { error: string } {
  if (!bearer) return { error: "missing_bearer" }
  const db = getDb()

  // First try static / DB key
  const row = db.query<KeyRow, [string]>("SELECT * FROM keys WHERE secret = ? AND disabled = 0").get(bearer)
  if (row) return rowToContext(row)

  // Otherwise try JWT
  const jwtClaims = verifyJwt(bearer)
  if ("error" in jwtClaims) return jwtClaims
  const tenantId = jwtClaims.sub
  if (!tenantId) return { error: "jwt_missing_sub" }

  let jwtRow = db.query<KeyRow, [string]>("SELECT * FROM keys WHERE kind='jwt' AND tenant_id = ?").get(tenantId)
  if (!jwtRow) {
    // First time we see this tenant — create a row using claims
    db.run(
      `INSERT INTO keys (kind, label, tenant_id, rpm, monthly_token_quota, monthly_request_quota, scopes, created_at)
       VALUES ('jwt', ?, ?, ?, ?, ?, ?, ?)`,
      [
        jwtClaims.label ?? `jwt:${tenantId}`,
        tenantId,
        jwtClaims.rpm ?? null,
        jwtClaims.tokenQuota ?? null,
        jwtClaims.requestQuota ?? null,
        jwtClaims.scopes?.join(",") ?? null,
        Date.now(),
      ],
    )
    jwtRow = db.query<KeyRow, [string]>("SELECT * FROM keys WHERE kind='jwt' AND tenant_id = ?").get(tenantId)!
  }
  return rowToContext(jwtRow)
}

interface JwtClaims {
  sub: string
  exp?: number
  iat?: number
  label?: string
  rpm?: number
  tokenQuota?: number
  requestQuota?: number
  scopes?: string[]
}

/** Verify a JWT (HS256 or RS256) and return claims. */
function verifyJwt(token: string): JwtClaims | { error: string } {
  const parts = token.split(".")
  if (parts.length !== 3) return { error: "not_a_jwt" }
  const headerB64 = parts[0]!
  const payloadB64 = parts[1]!
  const sigB64 = parts[2]!
  let header: { alg?: string; typ?: string }
  let payload: JwtClaims
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
  } catch {
    return { error: "jwt_malformed" }
  }
  // Verify signature
  const data = Buffer.from(`${headerB64}.${payloadB64}`)
  const sig = Buffer.from(sigB64, "base64url")

  if (header.alg === "HS256") {
    const secret = process.env.JWT_SECRET
    if (!secret) return { error: "jwt_secret_not_configured" }
    const expected = createHmac("sha256", secret).update(data).digest()
    if (sig.length !== expected.length) return { error: "jwt_bad_signature" }
    let ok = 0
    for (let i = 0; i < sig.length; i++) ok |= sig[i]! ^ expected[i]!
    if (ok !== 0) return { error: "jwt_bad_signature" }
  } else if (header.alg === "RS256") {
    const pub = process.env.JWT_PUBLIC_KEY
    if (!pub) return { error: "jwt_public_key_not_configured" }
    try {
      const key = createPublicKey({ key: pub, format: "pem" })
      const ok = verify("sha256", data, key, sig)
      if (!ok) return { error: "jwt_bad_signature" }
    } catch (e) {
      return { error: `jwt_verify_failed:${(e as Error).message}` }
    }
  } else {
    return { error: `unsupported_alg:${header.alg}` }
  }
  // Expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) return { error: "jwt_expired" }
  return payload
}

/** Issue a HS256 JWT — utility for admin / CLI scripts. */
export function signJwt(claims: JwtClaims, secret: string, expiresInSec = 30 * 24 * 3600): string {
  const header = { alg: "HS256", typ: "JWT" }
  const now = Math.floor(Date.now() / 1000)
  const payload = { iat: now, exp: now + expiresInSec, ...claims }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url")
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url")
  return `${headerB64}.${payloadB64}.${sig}`
}
