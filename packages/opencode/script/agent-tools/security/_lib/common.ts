/**
 * Shared utilities for the Security Toolkit (Burp Suite Pro–style).
 *
 * Each tool stays a single executable file, but imports from here for
 * any logic that's worth not duplicating (host validation, CLI parsing,
 * stdin reading, encoding detection, error fingerprints, etc).
 *
 * Keep this file dependency-free beyond Node/Bun built-ins.
 */
import { stdin } from "node:process"
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { gunzipSync, inflateRawSync, inflateSync, brotliDecompressSync } from "node:zlib"

// ---------------------------------------------------------------------------
// CLI argument helpers
// ---------------------------------------------------------------------------

export function makeArgs(argv: string[]) {
  const args = argv.slice(2)
  const has = (name: string): boolean => args.includes(name)
  const flag = (name: string): string | null => {
    const eq = args.find((x) => x.startsWith(`--${name}=`))
    if (eq) return eq.slice(`--${name}=`.length)
    const idx = args.indexOf(`--${name}`)
    if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
    return null
  }
  const num = (name: string, dflt: number): number => {
    const v = flag(name)
    if (v == null) return dflt
    const n = Number(v)
    return Number.isFinite(n) ? n : dflt
  }
  const required = (name: string): string => {
    const v = flag(name)
    if (v == null) bail(`missing --${name}`)
    return v
  }
  const list = (name: string): string[] => {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` || args[i] === `-${name[0]}`) {
        const v = args[i + 1]
        if (v && !v.startsWith("--")) out.push(v)
      } else if (args[i].startsWith(`--${name}=`)) {
        out.push(args[i].slice(`--${name}=`.length))
      }
    }
    return out
  }
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {}
    for (const v of list("header")) {
      const idx = v.indexOf(":")
      if (idx > 0) h[v.slice(0, idx).trim()] = v.slice(idx + 1).trim()
    }
    return h
  }
  return { args, has, flag, num, required, list, headers }
}

export function bail(msg: string, code = 2): never {
  console.error(`✗ ${msg}`)
  process.exit(code)
}

export function ok(msg: string) {
  console.log(`✓ ${msg}`)
}

export function info(msg: string) {
  console.error(msg)
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

export async function readStdin(): Promise<string> {
  const reader = (stdin as unknown as { stream?: () => ReadableStream<Uint8Array> }).stream
    ? (stdin as unknown as { stream: () => ReadableStream<Uint8Array> }).stream().getReader()
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

export async function readStdinBytes(): Promise<Buffer> {
  const reader = (stdin as unknown as { stream?: () => ReadableStream<Uint8Array> }).stream
    ? (stdin as unknown as { stream: () => ReadableStream<Uint8Array> }).stream().getReader()
    : null
  if (reader) {
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    stdin.on("data", (c) => chunks.push(c as Buffer))
    stdin.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

// ---------------------------------------------------------------------------
// Host validation (private/loopback gating used by every active tool)
// ---------------------------------------------------------------------------

export function isPrivateHost(host: string): boolean {
  if (!host) return false
  if (host === "localhost" || host === "::1") return true
  if (host.endsWith(".local") || host.endsWith(".internal")) return true
  const m4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (m4) {
    const a = Number(m4[1])
    const b = Number(m4[2])
    if (a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
    return false
  }
  // crude IPv6 check
  if (host.includes(":")) {
    if (host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return true
  }
  return false
}

export function ensureHostAllowed(url: string, allowPrivate: boolean) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    bail(`invalid URL: ${url}`)
  }
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    bail(
      `private/loopback target ${parsed.hostname} — pass --allow-private to confirm. ` +
        `This guard exists so AI agents don't hit the operator's intranet by accident.`,
    )
  }
}

// ---------------------------------------------------------------------------
// HTTP wire format helpers
// ---------------------------------------------------------------------------

export function isLikelyText(contentType: string): boolean {
  const ct = (contentType ?? "").toLowerCase()
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("html") ||
    ct.includes("yaml") ||
    ct.includes("urlencoded") ||
    ct.includes("form-data") ||
    ct.includes("graphql") ||
    ct.includes("svg") ||
    ct.includes("csv")
  )
}

export function decompressBody(buf: Buffer, contentEncoding: string | undefined): Buffer {
  const enc = (contentEncoding ?? "").toLowerCase().trim()
  if (!enc || enc === "identity") return buf
  try {
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(buf)
    if (enc === "deflate") {
      // Some servers send raw deflate without zlib header — try both
      try {
        return inflateSync(buf)
      } catch {
        return inflateRawSync(buf)
      }
    }
    if (enc === "br") return brotliDecompressSync(buf)
  } catch {
    // give up and return raw
  }
  return buf
}

export function parseSetCookie(headerValue: string): {
  name: string
  value: string
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
  maxAge?: number
  expires?: string
} | null {
  if (!headerValue) return null
  const parts = headerValue.split(";").map((p) => p.trim())
  if (!parts[0] || !parts[0].includes("=")) return null
  const [name, ...valueParts] = parts[0].split("=")
  const value = valueParts.join("=")
  const out: ReturnType<typeof parseSetCookie> = { name, value }
  for (const p of parts.slice(1)) {
    const [k, v] = p.split("=")
    const key = k.toLowerCase()
    if (key === "path") out!.path = v
    else if (key === "domain") out!.domain = v
    else if (key === "secure") out!.secure = true
    else if (key === "httponly") out!.httpOnly = true
    else if (key === "samesite") out!.sameSite = v
    else if (key === "max-age") out!.maxAge = Number(v)
    else if (key === "expires") out!.expires = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Sec headers analysis
// ---------------------------------------------------------------------------

export const SECURITY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "x-xss-protection",
] as const

export function gradeSecurityHeaders(
  headers: Record<string, string>,
): { score: number; max: number; missing: string[]; weak: string[] } {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v

  let score = 0
  const max = 8
  const missing: string[] = []
  const weak: string[] = []

  if (lower["strict-transport-security"]) {
    score += 1
    const m = /max-age=(\d+)/.exec(lower["strict-transport-security"])
    if (!m || Number(m[1]) < 31_536_000) weak.push("HSTS max-age < 1y")
  } else missing.push("strict-transport-security")

  if (lower["content-security-policy"]) {
    score += 1
    if (lower["content-security-policy"].includes("'unsafe-inline'")) weak.push("CSP contains 'unsafe-inline'")
    if (lower["content-security-policy"].includes("'unsafe-eval'")) weak.push("CSP contains 'unsafe-eval'")
  } else missing.push("content-security-policy")

  if (lower["x-frame-options"]) score += 1
  else if (!lower["content-security-policy"]?.includes("frame-ancestors")) missing.push("x-frame-options")

  if (lower["x-content-type-options"]?.toLowerCase() === "nosniff") score += 1
  else missing.push("x-content-type-options")

  if (lower["referrer-policy"]) score += 1
  else missing.push("referrer-policy")

  if (lower["permissions-policy"] || lower["feature-policy"]) score += 1
  else missing.push("permissions-policy")

  if (lower["cross-origin-opener-policy"]) score += 1
  else missing.push("cross-origin-opener-policy")

  if (lower["cross-origin-resource-policy"]) score += 1
  else missing.push("cross-origin-resource-policy")

  return { score, max, missing, weak }
}

// ---------------------------------------------------------------------------
// Error fingerprints (used by fuzzer + scanner + repeater)
// ---------------------------------------------------------------------------

export function detectErrorFingerprints(body: string): string[] {
  const out = new Set<string>()
  if (
    /SQL syntax|MySQL|sqlstate|ORA-\d+|PostgreSQL.*ERROR|sqlite3\.Operational|unclosed quotation mark|MariaDB|SQLITE_ERROR|psql:|near\s+"\?"|syntax error at or near|ODBC SQL Server Driver|Microsoft OLE DB Provider for SQL Server/i.test(
      body,
    )
  )
    out.add("sql_error")
  if (
    /Traceback \(most recent call last\)|Exception in thread|panic:|java\.lang\.\w+Exception|at \S+\(\S+:\d+\)|goroutine \d+ \[/i.test(
      body,
    )
  )
    out.add("stack_trace")
  if (/Fatal error|Warning: |Notice: |on line \d+|<b>(Warning|Notice|Fatal error)<\/b>/.test(body)) out.add("php_error")
  if (/Server Error in '\S+' Application|System\.\w+\.\w+Exception|ASP\.NET is configured/.test(body))
    out.add("dotnet_error")
  if (/\/etc\/passwd|root:x:0:0|HTTP\/1\.\d 200|\/proc\/self\/environ|Directory listing for/.test(body))
    out.add("info_leak")
  if (/<script[^>]*>[^<]*alert\(|onerror\s*=|javascript:[^"\s]+/i.test(body)) out.add("xss_reflect")
  if (/<\?xml|<!DOCTYPE\s+\w+\s*\[/.test(body)) out.add("xml_doc")
  if (/AWS_SECRET|AWS_ACCESS_KEY|aws_session_token|GOOGLE_API_KEY|firebase\.io/i.test(body)) out.add("cred_leak")
  if (/PRIVATE KEY-----|BEGIN OPENSSH PRIVATE KEY/.test(body)) out.add("private_key_leak")
  if (/CSRF token (mismatch|invalid|missing)|Invalid authenticity token/i.test(body)) out.add("csrf_protection")
  return [...out]
}

// ---------------------------------------------------------------------------
// File / payload helpers
// ---------------------------------------------------------------------------

export function loadPayloadFile(path: string): string[] {
  try {
    const text = readFileSync(path, "utf8")
    return text
      .split("\n")
      .map((s) => s.trimEnd())
      .filter((x) => x.length > 0 && !x.startsWith("#"))
  } catch (e) {
    bail(`could not read payload file ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Shannon entropy (used by sequencer + jwt + secret-scan)
// ---------------------------------------------------------------------------

export function shannonEntropy(s: string): number {
  if (!s) return 0
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  const len = s.length
  let h = 0
  for (const n of counts.values()) {
    const p = n / len
    h -= p * Math.log2(p)
  }
  return h
}

// ---------------------------------------------------------------------------
// Pretty timing
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function timed<T>(label: string): { stop: (extra?: T) => void } {
  const t0 = performance.now()
  return {
    stop(extra?: T) {
      const ms = Math.round(performance.now() - t0)
      info(`${label}: ${ms} ms${extra !== undefined ? ` ${JSON.stringify(extra)}` : ""}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Engagement file (audit trail for security tools)
// ---------------------------------------------------------------------------

export interface Engagement {
  name: string
  authorisation: string
  approved_by: string
  scope: { hosts: string[]; allow_private?: boolean; max_rps?: number }
  expires?: string
}

export function loadEngagement(path: string | null): Engagement | null {
  if (!path) return null
  try {
    const raw = readFileSync(path, "utf8")
    const data = JSON.parse(raw) as Engagement
    if (data.expires) {
      const t = Date.parse(data.expires)
      if (!Number.isNaN(t) && t < Date.now()) bail(`engagement file expired ${data.expires}`)
    }
    return data
  } catch (e) {
    bail(`bad engagement file ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function isHostInScope(host: string, eng: Engagement | null): boolean {
  if (!eng) return true // no engagement = public-net allowed via the private guard
  if (!eng.scope?.hosts || eng.scope.hosts.length === 0) return false
  for (const h of eng.scope.hosts) {
    if (h === host) return true
    if (h.startsWith("*.") && host.endsWith(h.slice(1))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// JSON output wrapper
// ---------------------------------------------------------------------------

export function emit(json: boolean, text: () => void, structured: () => unknown) {
  if (json) {
    console.log(JSON.stringify(structured(), null, 2))
  } else {
    text()
  }
}
