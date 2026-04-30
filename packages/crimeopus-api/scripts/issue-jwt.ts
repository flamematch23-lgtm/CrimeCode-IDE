#!/usr/bin/env bun
/**
 * issue-jwt.ts — CLI per emettere JWT per tenant multi-tenant.
 *
 * Uso:
 *   JWT_SECRET=$(openssl rand -hex 32) \
 *     bun scripts/issue-jwt.ts \
 *       --sub tenant-acme \
 *       --label "Acme Corp" \
 *       --rpm 120 \
 *       --token-quota 5000000 \
 *       --request-quota 50000 \
 *       --scopes chat,embed \
 *       --expires-in 30d
 *
 * Output: JWT pronto per `Authorization: Bearer <jwt>`
 */
import { signJwt } from "../src/auth.ts"

const args = process.argv.slice(2)
function flag(n: string): string | null {
  const eq = args.find((a) => a.startsWith(`--${n}=`))
  if (eq) return eq.slice(`--${n}=`.length)
  const i = args.indexOf(`--${n}`)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1]
  return null
}

const secret = process.env.JWT_SECRET
if (!secret) {
  console.error("✗ JWT_SECRET env var not set")
  console.error("  Generate one: openssl rand -hex 32")
  process.exit(2)
}

const sub = flag("sub")
if (!sub) {
  console.error("✗ --sub <tenant-id> required")
  console.error("\nUsage:")
  console.error("  bun scripts/issue-jwt.ts --sub TENANT [options]")
  console.error("\nOptions:")
  console.error("  --label NAME              human label for logs (default: jwt:<sub>)")
  console.error("  --rpm N                   per-key rate limit override")
  console.error("  --token-quota N           monthly token quota")
  console.error("  --request-quota N         monthly request quota")
  console.error("  --scopes a,b,c            comma-separated, default all")
  console.error("  --expires-in 30d|24h|3600 token lifetime (default 30d)")
  process.exit(2)
}

function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)?$/.exec(s.trim())
  if (!m) return 30 * 86400
  const n = Number(m[1])
  const unit = m[2] ?? "s"
  return n * (unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400)
}

const expiresIn = parseDuration(flag("expires-in") ?? "30d")
const claims = {
  sub,
  label: flag("label") ?? `jwt:${sub}`,
  rpm: flag("rpm") ? Number(flag("rpm")) : undefined,
  tokenQuota: flag("token-quota") ? Number(flag("token-quota")) : undefined,
  requestQuota: flag("request-quota") ? Number(flag("request-quota")) : undefined,
  scopes: flag("scopes")?.split(",").map((s) => s.trim()).filter(Boolean),
}

const token = signJwt(claims, secret, expiresIn)

console.error("✓ JWT issued")
console.error(`  sub:        ${sub}`)
console.error(`  label:      ${claims.label}`)
console.error(`  scopes:     ${claims.scopes?.join(",") ?? "(default: all)"}`)
console.error(`  rpm:        ${claims.rpm ?? "(default)"}`)
console.error(`  token quota: ${claims.tokenQuota ?? "(unlimited)"}`)
console.error(`  request q.:  ${claims.requestQuota ?? "(unlimited)"}`)
console.error(`  expires in: ${flag("expires-in") ?? "30d"}`)
console.error()
console.error("Pass to clients as Authorization: Bearer <token>")
console.error("─".repeat(60))
console.log(token)
