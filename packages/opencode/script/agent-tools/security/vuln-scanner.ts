#!/usr/bin/env bun
/**
 * vuln-scanner.ts — Burp Suite Scanner equivalent.
 *
 * Two flavours:
 *
 *   passive   inspect a captured request/response (or every flow in
 *             the proxy history) for issues without touching the
 *             target — missing security headers, info-disclosure,
 *             cookie flags, mixed content, JWT misuse, secrets in
 *             responses, etc.
 *
 *   active    send carefully-scoped probes to discover server-side
 *             issues: open redirect, reflected XSS, basic SQLi,
 *             SSRF, command-injection, CRLF, path traversal,
 *             default-creds. Each test is rate-limited and behind a
 *             per-class allow-list flag (default: nothing active runs
 *             without an explicit `--enable=class1,class2`).
 *
 *   batch     run passive over the entire proxy history DB, emit a
 *             ranked findings file for the agent to triage.
 *
 * Usage:
 *
 *   # passive scan a single response stored as raw HTTP
 *   bun vuln-scanner.ts passive --file response.txt
 *
 *   # passive scan every flow currently in the proxy DB
 *   bun vuln-scanner.ts batch --json > findings.json
 *
 *   # active scan, only enabling reflected-XSS + open-redirect, against an
 *   # explicit URL with auth
 *   bun vuln-scanner.ts active \
 *     --url 'https://target/search?q=§' \
 *     --header "Authorization: Bearer ..." \
 *     --enable xss-reflected,open-redirect \
 *     --rate-limit 4 --timeout 10000
 *
 * Findings format:
 *   { id, severity: 'info|low|medium|high|critical', class, title,
 *     evidence: {...}, location, recommendation }
 *
 * Safety: matches the rest of the toolkit — refuses private/loopback
 * targets without --allow-private, and active mode requires explicit
 * --enable.
 */
import { argv } from "node:process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import {
  detectErrorFingerprints,
  ensureHostAllowed,
  gradeSecurityHeaders,
  isLikelyText,
  makeArgs,
  parseSetCookie,
  bail,
  info,
} from "./_lib/common.ts"

const ACTIVE_CHECKS = [
  "xss-reflected",
  "open-redirect",
  "sqli-error",
  "sqli-boolean",
  "ssrf",
  "command-injection",
  "crlf",
  "path-traversal",
  "default-creds",
] as const
type ActiveCheck = (typeof ACTIVE_CHECKS)[number]

type Severity = "info" | "low" | "medium" | "high" | "critical"
const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }

const cli = makeArgs(argv)
const mode = cli.args[0]
const json = cli.has("--json")

if (!mode || ["--help", "-h"].includes(mode)) usage(0)

if (mode === "passive") await modePassive()
else if (mode === "active") await modeActive()
else if (mode === "batch") await modeBatch()
else usage(2)

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface Finding {
  id: string
  severity: Severity
  class: string
  title: string
  evidence: Record<string, unknown>
  location?: string
  recommendation?: string
}

// ---------------------------------------------------------------------------
// Passive
// ---------------------------------------------------------------------------

async function modePassive() {
  const file = cli.flag("file")
  const url = cli.flag("url")
  let request: Record<string, string> = {}
  let response: Record<string, string> = {}
  let body = ""
  let status = 0

  if (file) {
    const parsed = parseRawHttp(readFileSync(file, "utf8"))
    request = parsed.request
    response = parsed.response
    body = parsed.body
    status = parsed.status
  } else if (url) {
    const allowPrivate = cli.has("--allow-private")
    ensureHostAllowed(url, allowPrivate)
    const res = await fetch(url, { redirect: "manual" })
    body = await res.text()
    status = res.status
    res.headers.forEach((v, k) => (response[k] = v))
  } else {
    bail("provide --file <raw-http> or --url <url>")
  }

  const findings: Finding[] = []
  passiveAnalyse(findings, response, body, status, url ?? cli.flag("location") ?? "(unknown)", request)
  emitFindings(findings)
}

function parseRawHttp(raw: string): {
  request: Record<string, string>
  response: Record<string, string>
  body: string
  status: number
} {
  // Very loose parser — just split into header block + body. Handles either
  // "request only", "response only", or both glued with a blank line.
  const lines = raw.split(/\r?\n/)
  let i = 0
  const isReq = /^[A-Z]{3,8}\s+\S+\s+HTTP\//.test(lines[0])
  const isResp = /^HTTP\/[\d.]+\s+\d/.test(lines[0])
  const request: Record<string, string> = {}
  const response: Record<string, string> = {}
  let status = 0

  if (isReq) {
    i++
    while (i < lines.length && lines[i].length > 0) {
      const idx = lines[i].indexOf(":")
      if (idx > 0) request[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim()
      i++
    }
    i++ // blank
    // rest of body until we maybe hit a response
  }
  if (isResp || (i < lines.length && /^HTTP\/[\d.]+\s+\d/.test(lines[i]))) {
    if (lines[i]) {
      const m = /^HTTP\/[\d.]+\s+(\d+)/.exec(lines[i])
      if (m) status = Number(m[1])
    }
    i++
    while (i < lines.length && lines[i].length > 0) {
      const idx = lines[i].indexOf(":")
      if (idx > 0) response[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim()
      i++
    }
    i++
  }
  const body = lines.slice(i).join("\n")
  return { request, response, body, status }
}

function passiveAnalyse(
  out: Finding[],
  response: Record<string, string>,
  body: string,
  status: number,
  location: string,
  request?: Record<string, string>,
) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(response)) lower[k.toLowerCase()] = v

  // Security headers
  const grade = gradeSecurityHeaders(response)
  for (const m of grade.missing) {
    out.push({
      id: `missing-header-${m}`,
      severity: m === "content-security-policy" || m === "strict-transport-security" ? "medium" : "low",
      class: "security-headers",
      title: `Missing ${m}`,
      evidence: { header: m },
      location,
      recommendation: `Set the ${m} response header.`,
    })
  }
  for (const w of grade.weak) {
    out.push({
      id: `weak-header-${w.replace(/\s+/g, "-")}`,
      severity: "low",
      class: "security-headers",
      title: w,
      evidence: { detail: w },
      location,
    })
  }

  // Cookie flags
  const setCookies = lower["set-cookie"]?.split(/,(?=\s*\w+=)/) ?? []
  for (const sc of setCookies) {
    const c = parseSetCookie(sc.trim())
    if (!c) continue
    const flags: string[] = []
    if (!c.secure) flags.push("missing Secure")
    if (!c.httpOnly && /session|token|auth|csrf/i.test(c.name)) flags.push("missing HttpOnly")
    if (!c.sameSite) flags.push("missing SameSite")
    if (flags.length) {
      out.push({
        id: `cookie-${c.name}`,
        severity: "medium",
        class: "cookie-flags",
        title: `Cookie '${c.name}' has weak flags: ${flags.join(", ")}`,
        evidence: { cookie: c.name, flags },
        location,
        recommendation: "Add Secure, HttpOnly (for session cookies), SameSite=Strict|Lax.",
      })
    }
  }

  // Info disclosure
  const fps = detectErrorFingerprints(body)
  for (const fp of fps) {
    out.push({
      id: `fingerprint-${fp}`,
      severity: fp === "stack_trace" || fp === "private_key_leak" || fp === "cred_leak" ? "high" : "medium",
      class: "info-disclosure",
      title: `Response contains ${fp.replace(/_/g, " ")} fingerprint`,
      evidence: { fingerprint: fp },
      location,
      recommendation: "Hide framework error pages and sanitize error responses in production.",
    })
  }

  // Server / version banners
  const serverHeader = lower["server"]
  if (serverHeader && /\d/.test(serverHeader)) {
    out.push({
      id: "server-version-banner",
      severity: "info",
      class: "info-disclosure",
      title: `Server header reveals version: ${serverHeader}`,
      evidence: { header: serverHeader },
      location,
      recommendation: "Strip or obfuscate the Server header.",
    })
  }
  const xPowered = lower["x-powered-by"]
  if (xPowered) {
    out.push({
      id: "x-powered-by",
      severity: "info",
      class: "info-disclosure",
      title: `X-Powered-By header: ${xPowered}`,
      evidence: { header: xPowered },
      location,
      recommendation: "Remove the X-Powered-By header.",
    })
  }

  // Mixed content / non-HTTPS reference in HTML
  if (isLikelyText(lower["content-type"] ?? "") && location.startsWith("https://")) {
    const httpRefs = body.match(/(?:src|href|action)\s*=\s*["']http:\/\/[^"']+["']/gi) ?? []
    if (httpRefs.length) {
      out.push({
        id: "mixed-content",
        severity: "medium",
        class: "mixed-content",
        title: `${httpRefs.length} insecure HTTP reference(s) on HTTPS page`,
        evidence: { samples: httpRefs.slice(0, 5) },
        location,
        recommendation: "Use protocol-relative or HTTPS URLs.",
      })
    }
  }

  // CORS misconfig
  const acao = lower["access-control-allow-origin"]
  const acac = lower["access-control-allow-credentials"]
  if (acao === "*" && acac?.toLowerCase() === "true") {
    out.push({
      id: "cors-wildcard-with-credentials",
      severity: "high",
      class: "cors",
      title: "CORS allows '*' with credentials (browsers refuse, but indicates a likely misconfig)",
      evidence: { acao, acac },
      location,
      recommendation: "Echo a specific allow-listed origin instead of '*'.",
    })
  } else if (acao && acao !== "*" && /[^a-zA-Z0-9.-]/.test(acao.replace("https://", "").replace("http://", ""))) {
    // ACAO with unusual chars (could be reflected from request origin)
    out.push({
      id: "cors-reflective-origin",
      severity: "medium",
      class: "cors",
      title: `Access-Control-Allow-Origin appears reflective: ${acao}`,
      evidence: { acao },
      location,
    })
  }

  // JWT in body / Set-Cookie
  const jwts = body.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []
  for (const jwt of jwts.slice(0, 5)) {
    try {
      const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>
      if (header.alg === "none") {
        out.push({
          id: "jwt-alg-none",
          severity: "high",
          class: "jwt",
          title: "JWT uses alg=none",
          evidence: { jwtPrefix: jwt.slice(0, 60) + "…" },
          location,
        })
      }
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>
      if (typeof payload.exp !== "number") {
        out.push({
          id: "jwt-no-expiry",
          severity: "medium",
          class: "jwt",
          title: "JWT has no expiry claim",
          evidence: { jwtPrefix: jwt.slice(0, 60) + "…" },
          location,
        })
      }
    } catch {
      /* not JWT */
    }
  }

  // Secrets in response body
  const secretPatterns: Array<{ name: string; re: RegExp; sev: Severity }> = [
    { name: "AWS Access Key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, sev: "critical" },
    { name: "AWS Secret Key", re: /\b[A-Za-z0-9\/+=]{40}\b/, sev: "high" },
    { name: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/, sev: "critical" },
    { name: "Slack token", re: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, sev: "critical" },
    { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{36,}\b/, sev: "critical" },
    { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, sev: "critical" },
    { name: "Stripe key", re: /\bsk_(live|test)_[A-Za-z0-9]{20,}\b/, sev: "critical" },
  ]
  for (const p of secretPatterns) {
    const m = p.re.exec(body)
    if (m) {
      out.push({
        id: `secret-${p.name.replace(/\s+/g, "-").toLowerCase()}`,
        severity: p.sev,
        class: "secret-leak",
        title: `Possible ${p.name} in response body`,
        evidence: { match: m[0].slice(0, 12) + "…", offset: m.index },
        location,
        recommendation: "Never return secrets in HTTP responses. Rotate the leaked credential.",
      })
    }
  }

  // Open directory listing
  if (status === 200 && /<title>Index of \//i.test(body)) {
    out.push({
      id: "open-directory-listing",
      severity: "medium",
      class: "info-disclosure",
      title: "Open directory listing",
      evidence: {},
      location,
      recommendation: "Disable autoindex / directory listing.",
    })
  }

  // Cache-control of authenticated content
  const cc = lower["cache-control"] ?? ""
  if (request?.["authorization"] && !/no-store/i.test(cc)) {
    out.push({
      id: "auth-content-cacheable",
      severity: "low",
      class: "cache",
      title: `Authenticated response without Cache-Control: no-store (${cc || "none"})`,
      evidence: { cacheControl: cc },
      location,
    })
  }
}

// ---------------------------------------------------------------------------
// Active
// ---------------------------------------------------------------------------

async function modeActive() {
  const url = cli.required("url")
  const allowPrivate = cli.has("--allow-private")
  ensureHostAllowed(url, allowPrivate)
  const enableRaw = cli.flag("enable") ?? ""
  const enabled = new Set(enableRaw.split(",").map((s) => s.trim()).filter(Boolean) as ActiveCheck[])
  if (enabled.size === 0) {
    bail(
      `--enable required. Available: ${ACTIVE_CHECKS.join(", ")}\n` +
        `Active scanning is destructive. Pick what you want explicitly.`,
    )
  }
  for (const c of enabled) {
    if (!(ACTIVE_CHECKS as readonly string[]).includes(c)) bail(`unknown check: ${c}`)
  }
  const headers = cli.headers()
  const method = (cli.flag("method") ?? "GET").toUpperCase()
  const body = cli.flag("body") ?? undefined
  const rateLimit = cli.num("rate-limit", 4)
  const timeoutMs = cli.num("timeout", 10_000)

  const findings: Finding[] = []

  if (enabled.has("xss-reflected")) {
    findings.push(...(await checkXssReflected(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("open-redirect")) {
    findings.push(...(await checkOpenRedirect(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("sqli-error")) {
    findings.push(...(await checkSqliError(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("sqli-boolean")) {
    findings.push(...(await checkSqliBoolean(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("path-traversal")) {
    findings.push(...(await checkPathTraversal(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("crlf")) {
    findings.push(...(await checkCRLF(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("ssrf")) {
    findings.push(...(await checkSSRF(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("command-injection")) {
    findings.push(...(await checkCommandInjection(url, method, headers, body, rateLimit, timeoutMs)))
  }
  if (enabled.has("default-creds")) {
    findings.push(...(await checkDefaultCreds(url, headers, rateLimit, timeoutMs)))
  }

  emitFindings(findings)
}

interface ProbeContext {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  rateLimit: number
  timeoutMs: number
}

async function probe(
  ctx: ProbeContext,
  payload: string,
  placeholder: string,
): Promise<{ status: number; body: string; latencyMs: number; finalUrl: string; locationHeader: string | null }> {
  const url = ctx.url.includes(placeholder) ? ctx.url.replace(placeholder, encodeURIComponent(payload)) : ctx.url
  const body = ctx.body?.includes(placeholder) ? ctx.body.replace(placeholder, payload) : ctx.body
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ctx.timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: ctx.method,
      headers: ctx.headers,
      body,
      redirect: "manual",
      signal: ctrl.signal,
    })
    const text = await res.text().catch(() => "")
    return {
      status: res.status,
      body: text,
      latencyMs: Date.now() - t0,
      finalUrl: res.url,
      locationHeader: res.headers.get("location"),
    }
  } finally {
    clearTimeout(t)
  }
}

async function rateGate(rateLimit: number) {
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 / rateLimit)))
}

async function checkXssReflected(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const PLACEHOLDER = "§"
  const out: Finding[] = []
  const payloads = [
    `cc-xss-${Math.random().toString(36).slice(2, 10)}`,
    `<script>cc${Math.random().toString(36).slice(2, 6)}</script>`,
    `"><img src=x onerror=cc${Math.random().toString(36).slice(2, 6)}>`,
  ]
  if (!url.includes(PLACEHOLDER) && !body?.includes(PLACEHOLDER)) {
    info("xss-reflected: skipping — no §...§ placeholder in URL/body")
    return out
  }
  for (const p of payloads) {
    await rateGate(rateLimit)
    const r = await probe(ctx, p, PLACEHOLDER).catch(() => null)
    if (!r) continue
    if (r.body.includes(p)) {
      out.push({
        id: `xss-reflected-${p.slice(0, 8)}`,
        severity: "high",
        class: "xss-reflected",
        title: "Payload reflected in response body unencoded",
        evidence: { payload: p, status: r.status },
        location: url,
        recommendation: "Encode user input on output (HTML / JS / attribute context).",
      })
    }
  }
  return out
}

async function checkOpenRedirect(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const targets = [
    "https://example.com/cc-test",
    "//example.com/cc-test",
    "/\\example.com/cc-test",
    "https:%2f%2fexample.com",
  ]
  for (const t of targets) {
    await rateGate(rateLimit)
    const r = await probe(ctx, t, PLACEHOLDER).catch(() => null)
    if (!r) continue
    if (r.status >= 300 && r.status < 400 && r.locationHeader) {
      const loc = r.locationHeader.toLowerCase()
      if (loc.includes("example.com")) {
        out.push({
          id: `open-redirect-${t.slice(0, 6)}`,
          severity: "medium",
          class: "open-redirect",
          title: "Server redirects to attacker-controlled host",
          evidence: { payload: t, location: r.locationHeader, status: r.status },
          location: url,
          recommendation: "Validate redirect destinations against an allow-list.",
        })
        break
      }
    }
  }
  return out
}

async function checkSqliError(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const payloads = [`'`, `"`, `' OR '1'='1`, `1) ORDER BY 9999--`, `'; WAITFOR DELAY '0:0:0'--`]
  for (const p of payloads) {
    await rateGate(rateLimit)
    const r = await probe(ctx, p, PLACEHOLDER).catch(() => null)
    if (!r) continue
    const fps = detectErrorFingerprints(r.body)
    if (fps.includes("sql_error")) {
      out.push({
        id: `sqli-error-${p.slice(0, 8)}`,
        severity: "high",
        class: "sqli",
        title: "SQL error returned in response when injecting tautological payload",
        evidence: { payload: p, status: r.status, fingerprints: fps },
        location: url,
        recommendation: "Use parameterized queries. Suppress raw DB errors in responses.",
      })
      break
    }
  }
  return out
}

async function checkSqliBoolean(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const truePay = "1' OR '1'='1"
  const falsePay = "1' AND '1'='2"
  await rateGate(rateLimit)
  const tr = await probe(ctx, truePay, PLACEHOLDER).catch(() => null)
  await rateGate(rateLimit)
  const fr = await probe(ctx, falsePay, PLACEHOLDER).catch(() => null)
  if (tr && fr && tr.status === 200 && fr.status === 200) {
    const lenDelta = Math.abs(tr.body.length - fr.body.length)
    if (lenDelta > Math.max(50, tr.body.length * 0.05)) {
      out.push({
        id: "sqli-boolean",
        severity: "high",
        class: "sqli",
        title: "Boolean-based SQLi: TRUE / FALSE payloads return materially different responses",
        evidence: { trueLen: tr.body.length, falseLen: fr.body.length, delta: lenDelta },
        location: url,
        recommendation: "Use parameterized queries.",
      })
    }
  }
  return out
}

async function checkPathTraversal(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const payloads = ["../../../../etc/passwd", "..%2f..%2f..%2fetc%2fpasswd", "..\\..\\..\\windows\\win.ini"]
  for (const p of payloads) {
    await rateGate(rateLimit)
    const r = await probe(ctx, p, PLACEHOLDER).catch(() => null)
    if (!r) continue
    if (/root:x:0:0:|\[fonts\]/.test(r.body)) {
      out.push({
        id: `path-traversal-${p.slice(0, 8)}`,
        severity: "high",
        class: "path-traversal",
        title: "Server returned OS-file content via path traversal payload",
        evidence: { payload: p, status: r.status },
        location: url,
        recommendation: "Canonicalise paths server-side; reject '..' / encoded variants.",
      })
      break
    }
  }
  return out
}

async function checkCRLF(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const marker = `cc-crlf-${Math.random().toString(36).slice(2, 8)}`
  const payload = `%0d%0aX-Cc-Test:${marker}`
  await rateGate(rateLimit)
  const r = await probe(ctx, payload, PLACEHOLDER).catch(() => null)
  if (r && r.body.includes(marker) === false) {
    // also check if Set-Cookie or other response header reflects
    // We don't have headers here directly — see if response body reflects via echoing endpoints
    // Detection is best-effort.
  }
  // Detection done at fetch level isn't perfect — surface a low finding only if URL contains placeholders to test
  if (ctx.url.includes(PLACEHOLDER)) {
    // No reliable signal without full header capture in this simple probe
    out.push({
      id: "crlf-tested-inconclusive",
      severity: "info",
      class: "crlf",
      title: "CRLF probe sent — manual review of captured response needed",
      evidence: { payload },
      location: url,
    })
  }
  return out
}

async function checkSSRF(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const targets = ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/", "http://localhost/"]
  for (const t of targets) {
    await rateGate(rateLimit)
    const r = await probe(ctx, t, PLACEHOLDER).catch(() => null)
    if (!r) continue
    // AWS metadata fingerprint
    if (/ami-id|instance-id|iam\/security-credentials/.test(r.body)) {
      out.push({
        id: "ssrf-aws-metadata",
        severity: "critical",
        class: "ssrf",
        title: "Server reached AWS instance metadata service (169.254.169.254)",
        evidence: { payload: t, sample: r.body.slice(0, 200) },
        location: url,
        recommendation: "Block outgoing requests to link-local, internal, and metadata IPs from app code.",
      })
      break
    }
  }
  return out
}

async function checkCommandInjection(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const ctx: ProbeContext = { url, method, headers, body, rateLimit, timeoutMs }
  const out: Finding[] = []
  const PLACEHOLDER = "§"
  const marker = `ccmd${Math.random().toString(36).slice(2, 6)}`
  const payloads = [`;echo ${marker}`, `|echo ${marker}`, `\`echo ${marker}\``, `$(echo ${marker})`]
  for (const p of payloads) {
    await rateGate(rateLimit)
    const r = await probe(ctx, p, PLACEHOLDER).catch(() => null)
    if (!r) continue
    if (r.body.includes(marker)) {
      out.push({
        id: `cmd-injection-${p.slice(0, 6)}`,
        severity: "critical",
        class: "command-injection",
        title: "Command output reflected in response — injection confirmed",
        evidence: { payload: p, marker },
        location: url,
        recommendation: "Never concatenate user input into shell commands. Use exec with arg array.",
      })
      break
    }
  }
  return out
}

async function checkDefaultCreds(
  url: string,
  headers: Record<string, string>,
  rateLimit: number,
  timeoutMs: number,
): Promise<Finding[]> {
  const out: Finding[] = []
  const creds: Array<[string, string]> = [
    ["admin", "admin"],
    ["admin", "password"],
    ["admin", "12345"],
    ["root", "root"],
    ["administrator", "administrator"],
    ["user", "user"],
    ["test", "test"],
    ["guest", "guest"],
  ]
  for (const [u, p] of creds) {
    await rateGate(rateLimit)
    const auth = Buffer.from(`${u}:${p}`).toString("base64")
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { ...headers, Authorization: `Basic ${auth}` },
        signal: ctrl.signal,
      })
      // 2xx response that isn't a redirect to login indicates default-creds were accepted
      if (res.status >= 200 && res.status < 300) {
        out.push({
          id: `default-creds-${u}`,
          severity: "critical",
          class: "default-creds",
          title: `Default Basic-auth credentials accepted: ${u}:${p}`,
          evidence: { user: u, password: p, status: res.status },
          location: url,
          recommendation: "Force credential change on first login. Implement lockout.",
        })
        break
      }
    } catch {
      /* ignore */
    } finally {
      clearTimeout(t)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Batch (passive over proxy DB)
// ---------------------------------------------------------------------------

async function modeBatch() {
  const dataDir = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "crimecode",
    "proxy",
  )
  const dbPath = join(dataDir, "history.db")
  const db = new Database(dbPath, { readonly: true })
  const limit = cli.num("limit", 1000)
  const host = cli.flag("host")
  let sql = "SELECT * FROM flows"
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
    req_headers: string
    resp_headers: string | null
    resp_body: Buffer | null
    status: number | null
  }>

  const findings: Finding[] = []
  for (const r of rows) {
    const reqH = JSON.parse(r.req_headers) as Record<string, string>
    const respH = r.resp_headers ? (JSON.parse(r.resp_headers) as Record<string, string>) : {}
    const body = r.resp_body ? r.resp_body.toString("utf8") : ""
    const before = findings.length
    passiveAnalyse(findings, respH, body, r.status ?? 0, `${r.scheme}://${r.host}${r.path}`, reqH)
    // tag flow id
    for (let i = before; i < findings.length; i++) {
      findings[i].evidence = { ...findings[i].evidence, flowId: r.id }
    }
  }
  emitFindings(findings)
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emitFindings(findings: Finding[]) {
  // Dedupe by id+location+evidence
  const seen = new Set<string>()
  const dedup: Finding[] = []
  for (const f of findings) {
    const key = f.id + "|" + (f.location ?? "") + "|" + JSON.stringify(f.evidence)
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(f)
  }
  dedup.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])

  if (json) {
    console.log(JSON.stringify(dedup, null, 2))
    return
  }
  if (dedup.length === 0) {
    console.log("(no findings)")
    return
  }
  const colour = process.stdout.isTTY && !process.env.NO_COLOR
  const colourBy: Record<Severity, string> = {
    info: colour ? "\x1b[90m" : "",
    low: colour ? "\x1b[36m" : "",
    medium: colour ? "\x1b[33m" : "",
    high: colour ? "\x1b[31m" : "",
    critical: colour ? "\x1b[1;31m" : "",
  }
  const reset = colour ? "\x1b[0m" : ""
  console.log(`# Findings — ${dedup.length}\n`)
  for (const f of dedup) {
    console.log(`${colourBy[f.severity]}[${f.severity.toUpperCase()}]${reset} ${f.class} — ${f.title}`)
    if (f.location) console.log(`  ↳ ${f.location}`)
    if (Object.keys(f.evidence).length) console.log(`  evidence: ${JSON.stringify(f.evidence)}`)
    if (f.recommendation) console.log(`  ${colour ? "\x1b[2m" : ""}${f.recommendation}${reset}`)
    console.log()
  }
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`vuln-scanner.ts <mode> [flags]

Modes:
  passive   inspect a captured response or live URL (no harmful probes)
            --file PATH | --url URL  [--allow-private] [--location URL]

  active    send probes (DESTRUCTIVE — explicit allow-list required)
            --url URL --enable=xss-reflected,sqli-error,...
            --header "K:V"  --method M  --body BODY
            --rate-limit N  --timeout MS  [--allow-private]
            §...§ placeholders mark injection points in URL / body.

  batch     passive scan over the entire proxy history DB
            [--host SUBSTR] [--limit N]

Active checks: ${ACTIVE_CHECKS.join(", ")}

Common: --json
`)
  process.exit(code)
}
