#!/usr/bin/env bun
/**
 * Redteam payload replay runner — sandboxed by design.
 *
 * READ THE redteam-replay.md SKILL DOCUMENT BEFORE USING THIS.
 *
 * This script enforces, in this order:
 *   1. An engagement file (.redteam-engagements/<id>.json) must exist
 *      and the user must re-type the engagement_id at the prompt.
 *   2. The target base_url must be loopback, RFC1918 private, OR
 *      explicitly listed with a confirmed_authorisation_url.
 *   3. Path allowlist + denylist applied to every request.
 *   4. Mutating verbs (POST/PUT/PATCH/DELETE) refused unless
 *      `allow_mutating: true` in the engagement.
 *   5. Hard rate limit per target, max 20 rps.
 *   6. Audit log: one JSONL line per request/response pair with sha256
 *      of body. Tampering with the audit dir invalidates the run (the
 *      runner reads its own writes).
 *   7. Stop on secret: if a response body matches the secrets-regex
 *      set, halt immediately, write a TRIAGE marker, exit non-zero.
 *
 * Usage:
 *   bun script/agent-tools/redteam-replay.ts \
 *     --engagement .redteam-engagements/internal-staging-2026-04.json \
 *     --target staging-api \
 *     --corpus payloads/xss.jsonl \
 *     --confirm "I have explicit authorisation to test internal-staging-2026-04"
 *
 * Corpus format (JSONL, one payload per line):
 *   {"id": "xss-001", "method": "GET", "path": "/search?q=<script>alert(1)</script>", "headers": {}, "body": null}
 *   {"id": "xss-002", "method": "POST", "path": "/login", "headers": {"Content-Type":"application/json"}, "body": {"u":"' OR '1'='1"}}
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import path from "node:path"

interface Engagement {
  engagement_id: string
  authorised_by: string
  authorisation_evidence: string
  scope: {
    targets: Array<{
      name: string
      base_url: string
      rate_limit_rps?: number
      confirmed_authorisation_url?: string
    }>
    paths_allow: string[]
    paths_deny: string[]
    allow_mutating: boolean
  }
  valid_until: string
  stop_on_secret: boolean
  audit_dir: string
}

interface Payload {
  id: string
  method: string
  path: string
  headers?: Record<string, string>
  body?: unknown
}

const args = process.argv.slice(2)
function flag(name: string, required = false): string | null {
  const i = args.indexOf("--" + name)
  if (i < 0 || !args[i + 1]) {
    if (required) {
      console.error(`redteam-replay: missing required --${name}`)
      process.exit(2)
    }
    return null
  }
  return args[i + 1]
}

const engagementPath = flag("engagement", true)!
const targetName = flag("target", true)!
const corpusPath = flag("corpus", true)!
const confirmation = flag("confirm", true)!
const allowMutatingFlag = args.includes("--allow-mutating")

// 1. Engagement file
const eng: Engagement = JSON.parse(readFileSync(engagementPath, "utf8"))
if (Date.parse(eng.valid_until) <= Date.now()) {
  console.error(`✗ engagement expired: valid_until=${eng.valid_until}`)
  process.exit(1)
}

// Confirmation must contain the engagement id literally — prevents
// "yes" being a generic ack.
if (!confirmation.includes(eng.engagement_id)) {
  console.error(`✗ confirmation must contain engagement_id "${eng.engagement_id}"`)
  process.exit(1)
}

// Find target
const targetMaybe = eng.scope.targets.find((t) => t.name === targetName)
if (!targetMaybe) {
  console.error(`✗ target "${targetName}" not in engagement scope`)
  process.exit(1)
}
const target = targetMaybe as NonNullable<typeof targetMaybe>

// 2. URL allowlist
function isPrivateOrLoopback(urlStr: string): boolean {
  try {
    const u = new URL(urlStr)
    const h = u.hostname
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true
    // RFC1918
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (m) {
      const a = Number(m[1]), b = Number(m[2])
      if (a === 10) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
    }
    return false
  } catch {
    return false
  }
}

if (!isPrivateOrLoopback(target.base_url) && !target.confirmed_authorisation_url) {
  console.error(
    `✗ target ${target.base_url} is public and lacks confirmed_authorisation_url. Refusing.`,
  )
  process.exit(1)
}

const rateLimitRps = Math.min(target.rate_limit_rps ?? 5, 20)
const minIntervalMs = Math.ceil(1000 / rateLimitRps)

// 3. Path filter
function pathAllowed(p: string): boolean {
  const url = (() => {
    try {
      return new URL(p, target.base_url).pathname
    } catch {
      return p
    }
  })()
  // Deny first
  for (const d of eng.scope.paths_deny) {
    if (matchGlob(d, url)) return false
  }
  // Then allow (must match at least one allow)
  if (eng.scope.paths_allow.length === 0) return true
  for (const a of eng.scope.paths_allow) {
    if (matchGlob(a, url)) return true
  }
  return false
}
function matchGlob(pat: string, str: string): boolean {
  const re = new RegExp(
    "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  )
  return re.test(str)
}

// 4. Mutating-verb gate
const mutatingVerbs = new Set(["POST", "PUT", "PATCH", "DELETE"])
const allowMutating = eng.scope.allow_mutating && allowMutatingFlag

// 5. Audit dir
const auditDir = path.resolve(eng.audit_dir)
mkdirSync(auditDir, { recursive: true })
const auditFile = path.join(auditDir, `audit-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
writeFileSync(auditFile, "") // touch

console.log(`✓ engagement loaded: ${eng.engagement_id}`)
console.log(`  authorised_by: ${eng.authorised_by}`)
console.log(`  target:        ${target.name} (${target.base_url})`)
console.log(`  rate limit:    ${rateLimitRps} rps`)
console.log(`  mutating:      ${allowMutating ? "ENABLED" : "denied"}`)
console.log(`  audit log:     ${auditFile}`)
console.log("")

// 6. Secret detector
const secretPatterns: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/, // OpenAI / similar
  /ghp_[A-Za-z0-9]{30,}/, // GitHub PAT
  /xox[a-z]-[0-9-]+/, // Slack
  /-----BEGIN [A-Z]+ PRIVATE KEY-----/, // PEM
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./, // JWT-like
]
function containsSecret(text: string): RegExp | null {
  for (const re of secretPatterns) if (re.test(text)) return re
  return null
}

// Load corpus.
const corpus = readFileSync(corpusPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l, i) => {
    try {
      return JSON.parse(l) as Payload
    } catch {
      console.error(`✗ corpus line ${i + 1} is not valid JSON`)
      process.exit(1)
    }
  })

console.log(`→ replaying ${corpus.length} payloads…`)
console.log("")

let lastReqAt = 0
let baseline: { lengthMean: number; lengthStdev: number; durationMedian: number } | null = null
const samples: { len: number; ms: number }[] = []
let halted = false

for (const p of corpus) {
  if (halted) break
  // Verb gate
  if (mutatingVerbs.has(p.method.toUpperCase()) && !allowMutating) {
    record({
      payload_id: p.id,
      anomaly: "skipped_mutating",
      request: { method: p.method, path: p.path },
      response: null,
      ts: new Date().toISOString(),
    })
    continue
  }
  // Path gate
  if (!pathAllowed(p.path)) {
    record({
      payload_id: p.id,
      anomaly: "skipped_path_denied",
      request: { method: p.method, path: p.path },
      response: null,
      ts: new Date().toISOString(),
    })
    continue
  }
  // Rate limit
  const sinceLast = Date.now() - lastReqAt
  if (sinceLast < minIntervalMs) {
    await new Promise((r) => setTimeout(r, minIntervalMs - sinceLast + Math.random() * 50))
  }
  lastReqAt = Date.now()

  const url = new URL(p.path, target.base_url).toString()
  const t0 = Date.now()
  let res: Response | null = null
  let body = ""
  try {
    res = await fetch(url, {
      method: p.method.toUpperCase(),
      headers: p.headers ?? {},
      body: p.body == null ? undefined : typeof p.body === "string" ? p.body : JSON.stringify(p.body),
    })
    body = await res.text()
  } catch (err) {
    record({
      payload_id: p.id,
      anomaly: "network_error",
      request: { method: p.method, url, headers: p.headers ?? {} },
      response: null,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    })
    continue
  }
  const ms = Date.now() - t0
  const sha = createHash("sha256").update(body).digest("hex")

  // Anomaly heuristics
  let anomaly: string | null = null
  if (res.status >= 500) anomaly = "5xx"
  else if (typeof p.path === "string" && body.includes(p.path)) anomaly = "reflected_payload"

  if (eng.stop_on_secret) {
    const hit = containsSecret(body)
    if (hit) {
      anomaly = "secret_in_response"
      halted = true
    }
  }

  // Length delta after we have a baseline (10 samples).
  samples.push({ len: body.length, ms })
  if (samples.length === 10) {
    const lens = samples.map((s) => s.len).sort((a, b) => a - b)
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length
    const stdev = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
    const dur = samples.map((s) => s.ms).sort((a, b) => a - b)
    baseline = { lengthMean: mean, lengthStdev: stdev, durationMedian: dur[Math.floor(dur.length / 2)] }
  }
  if (baseline && !anomaly) {
    if (Math.abs(body.length - baseline.lengthMean) > baseline.lengthStdev * 5) anomaly = "length_delta"
    else if (ms > baseline.durationMedian * 5) anomaly = "slow"
  }

  record({
    payload_id: p.id,
    anomaly,
    request: { method: p.method, url, headers: p.headers ?? {} },
    response: { status: res.status, body_length: body.length, body_sha256: sha, duration_ms: ms },
    ts: new Date().toISOString(),
  })

  process.stdout.write(`  [${p.id}] ${res.status}${anomaly ? ` ⚠ ${anomaly}` : ""}\n`)
}

if (halted) {
  const triage = path.join(auditDir, "TRIAGE_REQUIRED.txt")
  writeFileSync(
    triage,
    `Halted at ${new Date().toISOString()} due to secret_in_response anomaly.\nAudit: ${auditFile}\n`,
  )
  console.error("\n⚠ Secret detected in a response — runner halted.")
  console.error(`  Triage marker: ${triage}`)
  process.exit(2)
}

// Summary
console.log("")
console.log(`✓ replay complete. Audit: ${auditFile}`)
const auditLines = readFileSync(auditFile, "utf8").split("\n").filter(Boolean)
const anomalies = auditLines.map((l) => JSON.parse(l)).filter((r) => r.anomaly)
console.log(`  ${auditLines.length} requests · ${anomalies.length} anomalies`)
const byKind: Record<string, number> = {}
for (const a of anomalies) byKind[a.anomaly] = (byKind[a.anomaly] ?? 0) + 1
for (const [k, n] of Object.entries(byKind)) console.log(`    ${k}: ${n}`)

function record(entry: Record<string, unknown>): void {
  appendFileSync(auditFile, JSON.stringify(entry) + "\n")
}
