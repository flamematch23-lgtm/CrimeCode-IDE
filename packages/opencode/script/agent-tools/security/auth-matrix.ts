#!/usr/bin/env bun
/**
 * auth-matrix.ts — Burp's Authorize / AuthMatrix extension equivalent.
 *
 * Tests authorization controls by replaying the same set of requests as
 * different identities (sessions / tokens / roles) and reporting where
 * the access decisions diverge. Catches BOLA / IDOR / vertical privilege
 * escalation / horizontal privilege escalation.
 *
 * Workflow:
 *   1. Define identities (a name + a set of headers/cookies/auth tokens)
 *   2. Define requests (URL/method/body to replay)
 *   3. For every (identity × request) pair, fire one request, capture
 *      status + size + a body fingerprint
 *   4. Build a matrix and compare against an expected access decision
 *      (allow/deny/unknown). Mismatches are flagged.
 *
 * Config file format (JSON):
 *
 * {
 *   "identities": [
 *     { "name": "anon",   "headers": {} },
 *     { "name": "user-A", "headers": { "Cookie": "session=A" } },
 *     { "name": "user-B", "headers": { "Cookie": "session=B" } },
 *     { "name": "admin",  "headers": { "Cookie": "session=admin" } }
 *   ],
 *   "requests": [
 *     { "name": "list-users", "url": "https://app/api/users",      "method": "GET",
 *       "expect": { "anon": "deny", "user-A": "deny", "user-B": "deny", "admin": "allow" } },
 *     { "name": "read-self",  "url": "https://app/api/users/A",    "method": "GET",
 *       "expect": { "anon": "deny", "user-A": "allow", "user-B": "deny", "admin": "allow" } },
 *     { "name": "read-other", "url": "https://app/api/users/B",    "method": "GET",
 *       "expect": { "anon": "deny", "user-A": "deny", "user-B": "allow", "admin": "allow" } }
 *   ],
 *   "rules": {
 *     "denyStatuses": [401, 403, 404],
 *     "allowStatuses": [200, 204]
 *   }
 * }
 *
 * Usage:
 *   bun auth-matrix.ts run    --config matrix.json --json
 *   bun auth-matrix.ts run    --config matrix.json --baseline admin
 *   bun auth-matrix.ts probe  --url https://x/api/y --identities matrix.json
 *
 * Modes:
 *   run          execute the full matrix
 *   probe        same but for a single ad-hoc URL
 *   from-history pull a few flows from the proxy DB and turn them into
 *                a starter requests array (the agent fills in expectations)
 */
import { argv } from "node:process"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { ensureHostAllowed, makeArgs, bail, info } from "./_lib/common.ts"

interface Identity {
  name: string
  headers?: Record<string, string>
  cookies?: Record<string, string>
}

interface AuthRequest {
  name: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  expect?: Record<string, "allow" | "deny" | "unknown">
}

interface Matrix {
  identities: Identity[]
  requests: AuthRequest[]
  rules?: {
    allowStatuses?: number[]
    denyStatuses?: number[]
  }
}

interface CellResult {
  identity: string
  request: string
  status: number
  size: number
  bodyHash: string
  durationMs: number
  decision: "allow" | "deny" | "unknown"
  expected?: "allow" | "deny" | "unknown"
  mismatch: boolean
}

const cli = makeArgs(argv)
const cmd = cli.args[0]
if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

const json = cli.has("--json")
const allowPrivate = cli.has("--allow-private")

if (cmd === "run") await cmdRun()
else if (cmd === "probe") await cmdProbe()
else if (cmd === "from-history") cmdFromHistory()
else usage(2)

// ---------------------------------------------------------------------------
// Run a full config
// ---------------------------------------------------------------------------

async function cmdRun() {
  const configPath = cli.required("config")
  const matrix = JSON.parse(readFileSync(configPath, "utf8")) as Matrix
  const allowStatuses = matrix.rules?.allowStatuses ?? [200, 201, 202, 204, 206]
  const denyStatuses = matrix.rules?.denyStatuses ?? [401, 403]

  // Validate: hosts must be in scope
  for (const r of matrix.requests) ensureHostAllowed(r.url, allowPrivate)

  const baselineName = cli.flag("baseline")
  const baseline = baselineName ? matrix.identities.find((i) => i.name === baselineName) : null
  if (baselineName && !baseline) bail(`baseline identity not found: ${baselineName}`)

  const cells: CellResult[] = []
  for (const r of matrix.requests) {
    for (const id of matrix.identities) {
      const result = await runCell(id, r, allowStatuses, denyStatuses)
      cells.push(result)
    }
  }

  // Cross-identity comparison: flag where a non-baseline identity returns
  // the same body hash as the baseline (privilege escalation candidate)
  const escalations: Array<{ request: string; identity: string; matchesBaseline: string }> = []
  if (baseline) {
    for (const r of matrix.requests) {
      const base = cells.find((c) => c.request === r.name && c.identity === baseline.name)
      if (!base || base.decision !== "allow") continue
      for (const id of matrix.identities) {
        if (id.name === baseline.name) continue
        const c = cells.find((cc) => cc.request === r.name && cc.identity === id.name)
        if (!c) continue
        if (c.bodyHash === base.bodyHash && c.status === base.status && base.size > 0) {
          escalations.push({ request: r.name, identity: id.name, matchesBaseline: baseline.name })
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ cells, escalations, summary: summarize(cells, escalations) }, null, 2))
    return
  }
  printText(matrix, cells, escalations)
}

async function runCell(
  id: Identity,
  r: AuthRequest,
  allowStatuses: number[],
  denyStatuses: number[],
): Promise<CellResult> {
  const headers: Record<string, string> = { ...(r.headers ?? {}), ...(id.headers ?? {}) }
  if (id.cookies) {
    const cookieStr = Object.entries(id.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
    headers["Cookie"] = headers["Cookie"] ? headers["Cookie"] + "; " + cookieStr : cookieStr
  }
  const t0 = Date.now()
  let status = 0
  let size = 0
  let bodyHash = ""
  try {
    const res = await fetch(r.url, {
      method: (r.method ?? "GET").toUpperCase(),
      headers,
      body: r.body,
      redirect: "manual",
    })
    status = res.status
    const buf = new Uint8Array(await res.arrayBuffer())
    size = buf.byteLength
    bodyHash = createHash("sha256").update(buf).digest("hex").slice(0, 16)
  } catch (e) {
    status = -1
    bodyHash = `ERR:${(e as Error).message.slice(0, 32)}`
  }
  const durationMs = Date.now() - t0
  let decision: "allow" | "deny" | "unknown"
  if (allowStatuses.includes(status)) decision = "allow"
  else if (denyStatuses.includes(status)) decision = "deny"
  else decision = "unknown"
  const expected = r.expect?.[id.name]
  const mismatch = expected !== undefined && expected !== "unknown" && expected !== decision
  return {
    identity: id.name,
    request: r.name,
    status,
    size,
    bodyHash,
    durationMs,
    decision,
    expected,
    mismatch,
  }
}

function summarize(
  cells: CellResult[],
  escalations: Array<{ request: string; identity: string; matchesBaseline: string }>,
) {
  const total = cells.length
  const mismatched = cells.filter((c) => c.mismatch).length
  const allowed = cells.filter((c) => c.decision === "allow").length
  const denied = cells.filter((c) => c.decision === "deny").length
  const unknown = cells.filter((c) => c.decision === "unknown").length
  return { total, mismatched, allowed, denied, unknown, escalations: escalations.length }
}

function printText(
  matrix: Matrix,
  cells: CellResult[],
  escalations: Array<{ request: string; identity: string; matchesBaseline: string }>,
) {
  const ids = matrix.identities.map((i) => i.name)
  const headerLine = ["request".padEnd(28), ...ids.map((i) => i.padEnd(12))].join(" ")
  console.log(`# Authorization Matrix\n`)
  console.log(headerLine)
  console.log("-".repeat(headerLine.length))
  for (const r of matrix.requests) {
    const cols = [r.name.padEnd(28)]
    for (const id of ids) {
      const c = cells.find((cc) => cc.request === r.name && cc.identity === id)
      if (!c) {
        cols.push("?".padEnd(12))
        continue
      }
      const flag = c.mismatch ? "⚠" : " "
      const sym = c.decision === "allow" ? "✓" : c.decision === "deny" ? "✗" : "?"
      cols.push(`${flag}${sym} ${String(c.status).padEnd(4)}${formatSizeShort(c.size)}`.padEnd(12))
    }
    console.log(cols.join(" "))
  }

  const summary = summarize(cells, escalations)
  console.log(`\nTotal cells: ${summary.total}  ·  allow: ${summary.allowed}  deny: ${summary.denied}  unknown: ${summary.unknown}`)
  if (summary.mismatched > 0) console.log(`\n⚠ ${summary.mismatched} expectation mismatch(es):`)
  for (const c of cells.filter((c) => c.mismatch)) {
    console.log(`  ${c.request}  ${c.identity}  expected=${c.expected} got=${c.decision} (${c.status})`)
  }
  if (escalations.length > 0) {
    console.log(`\n⚠ ${escalations.length} possible escalation(s):`)
    for (const e of escalations) {
      console.log(`  ${e.request}: ${e.identity}'s response matches ${e.matchesBaseline}'s`)
    }
  }
}

function formatSizeShort(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`
  return `${(n / (1024 * 1024)).toFixed(1)}M`
}

// ---------------------------------------------------------------------------
// Probe a single URL across identities
// ---------------------------------------------------------------------------

async function cmdProbe() {
  const url = cli.required("url")
  const idsPath = cli.required("identities")
  const idsConfig = JSON.parse(readFileSync(idsPath, "utf8")) as { identities: Identity[] }
  const matrix: Matrix = {
    identities: idsConfig.identities,
    requests: [{ name: "probe", url, method: cli.flag("method") ?? "GET", body: cli.flag("body") ?? undefined }],
  }
  ensureHostAllowed(url, allowPrivate)
  const cells: CellResult[] = []
  for (const id of matrix.identities) {
    const c = await runCell(id, matrix.requests[0], [200, 201, 204], [401, 403])
    cells.push(c)
  }
  if (json) console.log(JSON.stringify(cells, null, 2))
  else printText(matrix, cells, [])
}

// ---------------------------------------------------------------------------
// Convert N flows from proxy history into a starter Matrix
// ---------------------------------------------------------------------------

function cmdFromHistory() {
  const limit = cli.num("limit", 20)
  const host = cli.flag("host")
  const dbPath = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "crimecode",
    "proxy",
    "history.db",
  )
  if (!existsSync(dbPath)) bail(`no proxy DB at ${dbPath}`)
  const db = new Database(dbPath, { readonly: true })
  let sql = "SELECT id, method, scheme, host, path FROM flows"
  const params: unknown[] = []
  if (host) {
    sql += " WHERE host LIKE ?"
    params.push(`%${host}%`)
  }
  sql += " ORDER BY id DESC LIMIT ?"
  params.push(limit)
  const rows = db.query(sql).all(...(params as never[])) as Array<{
    id: number
    method: string
    scheme: string
    host: string
    path: string
  }>
  const matrix: Matrix = {
    identities: [
      { name: "anon", headers: {} },
      { name: "user", headers: { Cookie: "session=USER_REPLACE_ME" } },
      { name: "admin", headers: { Cookie: "session=ADMIN_REPLACE_ME" } },
    ],
    requests: rows.map((r) => ({
      name: `flow-${r.id}`,
      url: `${r.scheme}://${r.host}${r.path}`,
      method: r.method,
      expect: { anon: "deny", user: "unknown", admin: "allow" },
    })),
  }
  console.log(JSON.stringify(matrix, null, 2))
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`auth-matrix.ts <command> [flags]

Replay requests as multiple identities to detect missing authz.

Commands:
  run --config FILE [--baseline NAME] [--json] [--allow-private]
                         execute every (identity × request) pair from FILE

  probe --url URL --identities FILE [--method M --body B]
                         test one URL with all identities in the file

  from-history [--host H] [--limit N]
                         emit a starter matrix from the proxy DB
                         (then edit expectations + identities by hand)

The config file is JSON: { identities: [...], requests: [...], rules: {...} }
See the file header for an example schema.
`)
  process.exit(code)
}
