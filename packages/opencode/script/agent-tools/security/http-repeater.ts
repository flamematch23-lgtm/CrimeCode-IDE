#!/usr/bin/env bun
/**
 * http-repeater.ts — Burp Suite Repeater equivalent.
 *
 * Send an HTTP request with full control over method/URL/headers/body,
 * then optionally replay it N times with variations. Designed for the
 * authorised security agent — pair with the redteam-replay engagement
 * file when targeting non-loopback hosts.
 *
 * Modes:
 *   send       — fire one request, print structured result
 *   replay     — fire N copies, report timing distribution + status diff
 *   from-curl  — parse a curl command and run it via the same engine
 *   from-flow  — replay a captured proxy flow by id (with edits)
 *   from-har   — replay every entry in a HAR file
 *
 * Usage:
 *   bun http-repeater.ts send \
 *     --url https://target/api --method POST \
 *     --header "Content-Type: application/json" \
 *     --body '{"id":1}'
 *
 *   bun http-repeater.ts replay --url ... --count 20 --concurrency 4
 *
 *   pbpaste | bun http-repeater.ts from-curl
 *
 *   bun http-repeater.ts from-flow 42 \
 *     --override-header "Authorization: Bearer NEW" --json
 *
 * Output (default text):
 *   - status, latency, response size
 *   - response headers (security-relevant only) + grade
 *   - response body excerpt (first 4 KB, base64 if binary)
 *   - error fingerprints (sql_error / stack_trace / php_error / …)
 *
 * Output (--json): full structured object for piping into other tools.
 *
 * Safety: defers private-host gating to the shared lib. Pass
 * --allow-private to confirm intent on loopback / RFC1918 targets.
 */
import { argv, stdin } from "node:process"
import { performance } from "node:perf_hooks"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import {
  decompressBody,
  detectErrorFingerprints,
  ensureHostAllowed,
  formatBytes as fmtBytes,
  gradeSecurityHeaders,
  isLikelyText as isTextLib,
} from "./_lib/common.ts"

interface Result {
  url: string
  method: string
  status: number
  statusText: string
  latencyMs: number
  bytes: number
  headers: Record<string, string>
  bodyExcerpt: string
  bodyEncoding: "utf8" | "base64"
  redirected?: boolean
  finalUrl?: string
}

const args = argv.slice(2)
const mode = args[0]

if (!mode || ["--help", "-h"].includes(mode)) usage(0)

if (mode === "send") {
  await runSend()
} else if (mode === "replay") {
  await runReplay()
} else if (mode === "from-curl") {
  await runFromCurl()
} else if (mode === "from-flow") {
  await runFromFlow()
} else if (mode === "from-har") {
  await runFromHar()
} else {
  usage(2)
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function runSend() {
  const opts = parseRequest()
  const json = args.includes("--json")
  const result = await sendOne(opts)
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printResult(result)
  }
}

// ---------------------------------------------------------------------------
// Replay (N requests, report distribution)
// ---------------------------------------------------------------------------

async function runReplay() {
  const opts = parseRequest()
  const count = numFlag("count", 10)
  const concurrency = numFlag("concurrency", Math.min(4, count))
  const json = args.includes("--json")

  const results: Result[] = []
  let inflight = 0
  let nextIdx = 0
  const queue: Promise<void>[] = []

  while (nextIdx < count) {
    while (inflight < concurrency && nextIdx < count) {
      nextIdx++
      inflight++
      queue.push(
        sendOne(opts)
          .then((r) => {
            results.push(r)
          })
          .catch((e) => {
            results.push({
              url: opts.url,
              method: opts.method,
              status: -1,
              statusText: e instanceof Error ? e.message : String(e),
              latencyMs: 0,
              bytes: 0,
              headers: {},
              bodyExcerpt: "",
              bodyEncoding: "utf8",
            })
          })
          .finally(() => {
            inflight--
          }),
      )
    }
    await Promise.race(queue)
    queue.splice(0, queue.length - inflight)
  }
  await Promise.all(queue)

  // Aggregate.
  const latencies = results.map((r) => r.latencyMs).filter((x) => x > 0).sort((a, b) => a - b)
  const statusCounts = new Map<number, number>()
  for (const r of results) statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1)
  const summary = {
    count,
    statusDistribution: Object.fromEntries(statusCounts),
    latency: {
      min: latencies[0] ?? 0,
      median: latencies[Math.floor(latencies.length / 2)] ?? 0,
      p95: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
    },
    distinctBodies: new Set(results.map((r) => r.bodyExcerpt)).size,
  }

  if (json) {
    console.log(JSON.stringify({ summary, results }, null, 2))
  } else {
    console.log(`# Replay — ${count} requests, ${concurrency} concurrent\n`)
    console.log(`Status distribution: ${[...statusCounts].map(([s, n]) => `${s}×${n}`).join(", ")}`)
    console.log(`Latency: min=${summary.latency.min}ms p50=${summary.latency.median}ms p95=${summary.latency.p95}ms max=${summary.latency.max}ms`)
    console.log(`Distinct response bodies: ${summary.distinctBodies}/${count}`)
    if (summary.distinctBodies > 1 && statusCounts.size === 1) {
      console.log(`\n⚠️  Status uniform but bodies differ — possible reflection / timing side channel.`)
    }
  }
}

// ---------------------------------------------------------------------------
// from-curl — parse a curl command on stdin and execute it
// ---------------------------------------------------------------------------

async function runFromCurl() {
  const text = await readStdin()
  const opts = parseCurl(text)
  const json = args.includes("--json")
  const result = await sendOne(opts)
  if (json) console.log(JSON.stringify(result, null, 2))
  else printResult(result)
}

// ---------------------------------------------------------------------------
// from-flow — pull a captured request from the proxy DB and (re)send it
// ---------------------------------------------------------------------------

async function runFromFlow() {
  const id = Number(args[1])
  if (!Number.isFinite(id)) {
    console.error("usage: from-flow <id> [--override-header K:V] [--override-body STRING] [--override-method M]")
    process.exit(2)
  }
  const dataDir = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "crimecode",
    "proxy",
  )
  const dbPath = join(dataDir, "history.db")
  const db = new Database(dbPath, { readonly: true })
  const row = db.query("SELECT * FROM flows WHERE id = ?").get(id) as
    | {
        method: string
        scheme: string
        host: string
        port: number
        path: string
        req_headers: string
        req_body: Buffer | null
      }
    | undefined
  if (!row) {
    console.error(`✗ no flow with id ${id}`)
    process.exit(2)
  }
  const headers = JSON.parse(row.req_headers) as Record<string, string>
  // Apply overrides
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--override-header") {
      const v = args[i + 1] ?? ""
      const idx = v.indexOf(":")
      if (idx > 0) headers[v.slice(0, idx).trim()] = v.slice(idx + 1).trim()
    } else if (args[i] === "--override-method") {
      row.method = args[i + 1]
    }
  }
  let body = row.req_body ? row.req_body.toString("utf8") : undefined
  const oBody = parseFlag("override-body")
  if (oBody !== null) body = oBody

  const opts: ReqOpts = {
    url: `${row.scheme}://${row.host}${row.path}`,
    method: row.method.toUpperCase(),
    headers,
    body,
    timeoutMs: numFlag("timeout", 15_000),
    followRedirects: !args.includes("--no-redirect"),
  }
  const json = args.includes("--json")
  const result = await sendOne(opts)
  if (json) console.log(JSON.stringify(result, null, 2))
  else printResult(result)
}

// ---------------------------------------------------------------------------
// from-har — replay every entry in a HAR file
// ---------------------------------------------------------------------------

async function runFromHar() {
  const path = args[1]
  if (!path) {
    console.error("usage: from-har <path-to-har> [--limit N] [--filter substring]")
    process.exit(2)
  }
  const har = JSON.parse(readFileSync(path, "utf8")) as {
    log?: { entries?: Array<{ request: { method: string; url: string; headers: Array<{ name: string; value: string }>; postData?: { text: string } } }> }
  }
  const entries = har.log?.entries ?? []
  const limit = numFlag("limit", entries.length)
  const filter = parseFlag("filter")
  const json = args.includes("--json")
  const out: Result[] = []
  let i = 0
  for (const e of entries.slice(0, limit)) {
    if (filter && !e.request.url.includes(filter)) continue
    const headers: Record<string, string> = {}
    for (const h of e.request.headers ?? []) headers[h.name] = h.value
    try {
      const r = await sendOne({
        url: e.request.url,
        method: e.request.method,
        headers,
        body: e.request.postData?.text,
        timeoutMs: numFlag("timeout", 15_000),
        followRedirects: !args.includes("--no-redirect"),
      })
      out.push(r)
      if (++i % 10 === 0) console.error(`  ${i} requests done`)
    } catch (err) {
      console.error(`  ✗ ${e.request.url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2))
  else for (const r of out) printResult(r)
}

interface ReqOpts {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  followRedirects: boolean
}

function parseRequest(): ReqOpts {
  const url = required("url")
  const method = (parseFlag("method") ?? "GET").toUpperCase()
  const body = parseFlag("body") ?? undefined
  const timeoutMs = numFlag("timeout", 15_000)
  const followRedirects = !args.includes("--no-redirect")

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
  return { url, method, headers, body, timeoutMs, followRedirects }
}

function parseCurl(text: string): ReqOpts {
  // Light-weight curl parser. Handles common flags: -X/--request,
  // -H/--header, -d/--data, -b/--cookie, -L/--location, --url, naked URL.
  // Doesn't support all curl flags — that'd be a project of its own.
  const tokens = tokenize(text.replace(/\\\s*\n/g, " "))
  let i = 0
  if (tokens[0] === "curl") i++
  const headers: Record<string, string> = {}
  let url = ""
  let method = "GET"
  let body: string | undefined
  let followRedirects = false
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === "-X" || t === "--request") {
      method = (tokens[++i] ?? "GET").toUpperCase()
    } else if (t === "-H" || t === "--header") {
      const v = tokens[++i] ?? ""
      const idx = v.indexOf(":")
      if (idx > 0) headers[v.slice(0, idx).trim()] = v.slice(idx + 1).trim()
    } else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      body = tokens[++i] ?? ""
      if (method === "GET") method = "POST"
    } else if (t === "-b" || t === "--cookie") {
      headers["Cookie"] = tokens[++i] ?? ""
    } else if (t === "-L" || t === "--location") {
      followRedirects = true
    } else if (t === "--url") {
      url = tokens[++i] ?? ""
    } else if (!t.startsWith("-") && !url) {
      url = t
    } else if (t === "--compressed" || t === "-i" || t === "--include" || t === "-s" || t === "--silent") {
      // ignore — output flags
    } else if (t.startsWith("-")) {
      // unknown flag with arg
      i++
    }
    i++
  }
  if (!url) bail("could not find URL in curl command")
  return { url, method, headers, body, timeoutMs: 15_000, followRedirects }
}

function tokenize(s: string): string[] {
  const out: string[] = []
  let i = 0
  let cur = ""
  let mode: "ws" | "raw" | "single" | "double" = "ws"
  while (i < s.length) {
    const ch = s[i]
    if (mode === "ws") {
      if (/\s/.test(ch)) {
        i++
        continue
      }
      if (ch === "'") {
        mode = "single"
        cur = ""
      } else if (ch === '"') {
        mode = "double"
        cur = ""
      } else {
        mode = "raw"
        cur = ch
      }
      i++
      continue
    }
    if (mode === "raw") {
      if (/\s/.test(ch)) {
        out.push(cur)
        cur = ""
        mode = "ws"
      } else {
        cur += ch
      }
      i++
      continue
    }
    if (mode === "single") {
      if (ch === "'") {
        out.push(cur)
        cur = ""
        mode = "ws"
      } else {
        cur += ch
      }
      i++
      continue
    }
    if (mode === "double") {
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[i + 1]
        i += 2
        continue
      }
      if (ch === '"') {
        out.push(cur)
        cur = ""
        mode = "ws"
      } else {
        cur += ch
      }
      i++
      continue
    }
  }
  if (mode !== "ws" && cur) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

async function sendOne(opts: ReqOpts): Promise<Result> {
  // Honour the shared private-host gate (skipped when --allow-private)
  ensureHostAllowed(opts.url, args.includes("--allow-private"))
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: opts.followRedirects ? "follow" : "manual",
      signal: ctrl.signal,
    })
    const latencyMs = Math.round(performance.now() - t0)
    const buffer = Buffer.from(await res.arrayBuffer())
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k] = v))
    // Decompress if needed (fetch usually does this transparently, but
    // some servers send content-encoding without auto-decoded body)
    const decoded = decompressBody(buffer, headers["content-encoding"])
    const ct = headers["content-type"] ?? ""
    const isText = isTextLib(ct) || isLikelyText(ct)
    return {
      url: opts.url,
      method: opts.method,
      status: res.status,
      statusText: res.statusText,
      latencyMs,
      bytes: buffer.length,
      headers,
      bodyExcerpt: isText
        ? decoded.subarray(0, 4096).toString("utf8")
        : decoded.subarray(0, 4096).toString("base64"),
      bodyEncoding: isText ? "utf8" : "base64",
      redirected: res.redirected,
      finalUrl: res.url,
    }
  } finally {
    clearTimeout(t)
  }
}

function isLikelyText(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("html") ||
    ct.includes("yaml") ||
    ct.includes("urlencoded")
  )
}

function printResult(r: Result) {
  console.log(`${r.method} ${r.url}`)
  console.log(`  → ${r.status} ${r.statusText}  ${r.latencyMs} ms  ${fmtBytes(r.bytes)}`)
  if (r.redirected) console.log(`  redirected to: ${r.finalUrl}`)
  // Highlight security headers
  const sec = [
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
    "set-cookie",
    "cache-control",
  ]
  for (const k of sec) {
    if (r.headers[k]) console.log(`  ${k}: ${r.headers[k].slice(0, 200)}`)
  }
  // Security-headers grade
  const grade = gradeSecurityHeaders(r.headers)
  if (grade.missing.length > 0 || grade.weak.length > 0) {
    console.log(`  sec-headers: ${grade.score}/${grade.max}  missing: ${grade.missing.join(", ") || "—"}`)
    if (grade.weak.length) console.log(`               weak: ${grade.weak.join("; ")}`)
  }
  if (r.bodyEncoding === "utf8") {
    const fps = detectErrorFingerprints(r.bodyExcerpt)
    if (fps.length) console.log(`  fingerprints: ${fps.join(", ")}`)
  }
  console.log(`\nResponse body (${r.bodyEncoding}, first 4 KB):`)
  console.log(r.bodyExcerpt)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

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

async function readStdin(): Promise<string> {
  const reader = (stdin as unknown as { stream(): ReadableStream<Uint8Array> }).stream
    ? (stdin as unknown as { stream(): ReadableStream<Uint8Array> }).stream().getReader()
    : null
  if (reader) {
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    stdin.on("data", (c) => chunks.push(c as Buffer))
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

function usage(code: number): never {
  console.error(`http-repeater.ts <send|replay|from-curl|from-flow|from-har> [flags]

Modes:
  send         single request, print result
  replay       fire N requests, report timing + status distribution
  from-curl    parse a curl command on stdin, execute
  from-flow    replay a captured proxy flow by id (with overrides)
  from-har     replay every entry in a HAR file

Common flags:
  --url <url>            (required for send/replay)
  --method GET|POST|...  (default GET)
  --header "K: V"        (repeatable)
  --body <string>
  --timeout <ms>         (default 15000)
  --no-redirect          don't follow redirects
  --allow-private        permit private/loopback hosts

Replay-only:
  --count <N>            (default 10)
  --concurrency <N>      (default min(4, count))

from-flow:
  <id>                              proxy flow id
  --override-header "K:V"           replace/add header (repeatable)
  --override-method M               new method
  --override-body S                 replace body

from-har:
  <path>                            HAR file
  --limit N                         only first N entries
  --filter SUBSTR                   only URLs containing this

Common: --json
`)
  process.exit(code)
}
