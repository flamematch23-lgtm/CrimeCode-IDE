#!/usr/bin/env bun
/**
 * param-miner.ts — Burp Suite "Param Miner" / hidden-parameter
 * discovery equivalent.
 *
 * Probes a target endpoint with candidate parameter names and reports
 * which ones change the response — that's how you find undocumented
 * query strings, headers, cookies, JSON keys.
 *
 * Modes:
 *
 *   query    fuzz query-string parameters (?a=…)
 *   header   fuzz request header names
 *   cookie   fuzz cookie names
 *   body     fuzz JSON / form body keys
 *
 * Detection:
 *   For each candidate name, send the baseline + the request with the
 *   candidate set to a unique guard string. If the response differs
 *   meaningfully (status, length, body hash) it gets flagged.
 *
 * Usage:
 *
 *   bun param-miner.ts query --url 'https://target/?...' \
 *     --wordlist wordlists/params.txt
 *
 *   bun param-miner.ts header --url 'https://target/' \
 *     --wordlist wordlists/headers.txt --rate-limit 10
 *
 * If no --wordlist is passed, a built-in shortlist of ~250 common
 * names is used.
 */
import { argv } from "node:process"
import { performance } from "node:perf_hooks"
import { createHash } from "node:crypto"
import { ensureHostAllowed, loadPayloadFile, makeArgs, bail, info } from "./_lib/common.ts"

// ---------------------------------------------------------------------------
// Built-in wordlists (declared before main flow so const-init ordering holds)
// ---------------------------------------------------------------------------

const QUERY_WORDS_RAW = `
admin api auth callback code data debug dest destination email file format help host id image
include input json key lang language load locale log mode module name next next_url offset output
page param path platform port q query r raw redir redirect ref return root sandbox search session
src target test text time token type upload url user view xml access account action archive avatar
bypass cmd command count delete dir do dump enable encoded env exec export filter id_token impersonate
import lookup magic message metadata mock note object open ping post print pretty profile proxy
public range raw_token role schema secret select session_id share signed sort source sql staging
stat status step subject tab template trace trigger uid uri user_id verbose verify wp_user x_csrf
`
const HEADER_WORDS_RAW = `
X-Forwarded-For X-Forwarded-Host X-Forwarded-Proto X-Real-IP X-Original-URL X-Rewrite-URL
X-Original-Host X-Original-Remote-Addr X-Custom-IP-Authorization X-Originating-IP
X-Remote-IP X-Remote-Addr X-Client-IP X-Trusted-Proxy X-Forwarded-Server X-HTTP-Method-Override
X-Method-Override X-HTTP-Method X-Host X-Forwarded-Path X-Forwarded-Scheme
X-User X-Auth-User X-User-ID X-Username X-Email X-Forwarded-User X-Authenticated-User
X-Original-Authorization X-Wrap-Auth X-Account X-Account-ID X-Org X-Tenant X-Workspace X-Customer
X-Internal X-Internal-Token X-Debug X-Debug-Token X-Trace X-Bypass-Cache X-Cache-Key
Forwarded True-Client-IP CF-Connecting-IP X-Backend-Server X-Cluster-Client-IP
`
const COOKIE_WORDS_RAW = `
admin auth debug session token user role test bypass impersonate beta canary
sudo tenant org workspace customer staging api_token JSESSIONID PHPSESSID
laravel_session connect.sid express:sess _csrf
`
const QUERY_WORDS = QUERY_WORDS_RAW.trim().split(/\s+/)
const HEADER_WORDS = HEADER_WORDS_RAW.trim().split(/\s+/)
const COOKIE_WORDS = COOKIE_WORDS_RAW.trim().split(/\s+/)
const BODY_WORDS = QUERY_WORDS

const DEFAULT_WORDLIST: Record<"query" | "header" | "cookie" | "body", string[]> = {
  query: QUERY_WORDS,
  header: HEADER_WORDS,
  cookie: COOKIE_WORDS,
  body: BODY_WORDS,
}

const cli = makeArgs(argv)
const mode = cli.args[0]
if (!mode || ["--help", "-h"].includes(mode)) usage(0)

if (!["query", "header", "cookie", "body"].includes(mode)) usage(2)

const url = cli.required("url")
const allowPrivate = cli.has("--allow-private")
ensureHostAllowed(url, allowPrivate)
const headers = cli.headers()
const method = (cli.flag("method") ?? "GET").toUpperCase()
const baseBody = cli.flag("body") ?? undefined
const rateLimit = cli.num("rate-limit", 10)
const timeoutMs = cli.num("timeout", 12_000)
const wordlist = cli.flag("wordlist") ? loadPayloadFile(cli.flag("wordlist")!) : DEFAULT_WORDLIST[mode as keyof typeof DEFAULT_WORDLIST]
const guard = `cc${Math.random().toString(36).slice(2, 10)}`
const json = cli.has("--json")

if (wordlist.length === 0) bail("empty wordlist")

info(`Probing ${wordlist.length} candidate ${mode} names against ${url}…`)
const baseline = await fireOne(null)

interface Hit {
  name: string
  baselineStatus: number
  status: number
  baselineLen: number
  len: number
  reflected: boolean
  bodyDelta: number
  headerDeltas: string[]
  rttMs: number
}

const hits: Hit[] = []
const tickMs = Math.max(50, 1000 / rateLimit)
let lastTick = 0

for (let i = 0; i < wordlist.length; i++) {
  const name = wordlist[i]
  const wait = lastTick + tickMs - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastTick = Date.now()
  try {
    const r = await fireOne(name)
    if (isInteresting(baseline, r, name)) {
      hits.push({
        name,
        baselineStatus: baseline.status,
        status: r.status,
        baselineLen: baseline.bodyLen,
        len: r.bodyLen,
        reflected: r.body.includes(guard),
        bodyDelta: Math.abs(r.bodyLen - baseline.bodyLen),
        headerDeltas: diffHeaders(baseline.headers, r.headers),
        rttMs: r.rttMs,
      })
    }
  } catch {
    /* skip */
  }
  if ((i + 1) % 50 === 0) info(`  ${i + 1}/${wordlist.length}, hits ${hits.length}`)
}

emit()

// ---------------------------------------------------------------------------

interface Resp {
  status: number
  body: string
  bodyLen: number
  headers: Record<string, string>
  rttMs: number
}

async function fireOne(candidate: string | null): Promise<Resp> {
  let reqUrl = url
  let reqHeaders = { ...headers }
  let reqBody: string | undefined = baseBody

  if (candidate !== null) {
    if (mode === "query") {
      const u = new URL(url)
      u.searchParams.set(candidate, guard)
      reqUrl = u.toString()
    } else if (mode === "header") {
      reqHeaders[candidate] = guard
    } else if (mode === "cookie") {
      const existing = reqHeaders["Cookie"] ?? reqHeaders["cookie"] ?? ""
      reqHeaders["Cookie"] = existing ? `${existing}; ${candidate}=${guard}` : `${candidate}=${guard}`
    } else if (mode === "body") {
      const ct = (reqHeaders["Content-Type"] ?? reqHeaders["content-type"] ?? "").toLowerCase()
      if (ct.includes("json")) {
        let obj: Record<string, unknown> = {}
        try {
          obj = baseBody ? JSON.parse(baseBody) : {}
        } catch {
          obj = {}
        }
        obj[candidate] = guard
        reqBody = JSON.stringify(obj)
      } else {
        // form-encoded
        const params = new URLSearchParams(baseBody ?? "")
        params.set(candidate, guard)
        reqBody = params.toString()
      }
    }
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(reqUrl, {
      method,
      headers: reqHeaders,
      body: reqBody,
      redirect: "manual",
      signal: ctrl.signal,
    })
    const body = await res.text().catch(() => "")
    const respHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => (respHeaders[k] = v))
    return {
      status: res.status,
      body,
      bodyLen: body.length,
      headers: respHeaders,
      rttMs: Math.round(performance.now() - t0),
    }
  } finally {
    clearTimeout(t)
  }
}

function isInteresting(b: Resp, r: Resp, _name: string): boolean {
  if (r.status !== b.status) return true
  if (Math.abs(r.bodyLen - b.bodyLen) > Math.max(20, b.bodyLen * 0.02)) return true
  if (r.body.includes(guard)) return true
  // header set differs?
  const newKeys = Object.keys(r.headers).filter((k) => !(k in b.headers))
  if (newKeys.length > 0) return true
  // body hash differs while length didn't
  const hb = createHash("sha1").update(b.body).digest("hex")
  const hr = createHash("sha1").update(r.body).digest("hex")
  if (hb !== hr && Math.abs(r.bodyLen - b.bodyLen) > 0) return true
  return false
}

function diffHeaders(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].map((k) => k.toLowerCase()))
  const out: string[] = []
  for (const k of keys) {
    const av = a[k] ?? Object.entries(a).find(([kk]) => kk.toLowerCase() === k)?.[1]
    const bv = b[k] ?? Object.entries(b).find(([kk]) => kk.toLowerCase() === k)?.[1]
    if (av !== bv) out.push(k)
  }
  return out
}

function emit() {
  if (json) {
    console.log(JSON.stringify({ baseline: { status: baseline.status, len: baseline.bodyLen }, hits }, null, 2))
    return
  }
  if (hits.length === 0) {
    console.log("(no hidden parameters detected)")
    return
  }
  hits.sort((a, b) => Math.abs(b.bodyDelta) - Math.abs(a.bodyDelta))
  console.log(`# Param-miner — baseline ${baseline.status} ${baseline.bodyLen} bytes\n`)
  console.log(`name`.padEnd(28) + `Δstatus  Δlen     refl  hdrΔ`)
  console.log("-".repeat(70))
  for (const h of hits.slice(0, 200)) {
    const ds = h.status === h.baselineStatus ? "    -" : `${h.baselineStatus}→${h.status}`.padEnd(8)
    const dl = (h.len - h.baselineLen).toString().padStart(7)
    const refl = h.reflected ? "yes" : "  "
    console.log(`${h.name.padEnd(28)}${ds}  ${dl}  ${refl.padEnd(5)} ${h.headerDeltas.join(",").slice(0, 30)}`)
  }
  if (hits.length > 200) console.log(`… ${hits.length - 200} more`)
}

// ---------------------------------------------------------------------------
// (Built-in wordlists are declared near the top so the main code can reference
// them — see DEFAULT_WORDLIST above.)
// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`param-miner.ts <mode> [flags]

Modes:
  query | header | cookie | body

Common:
  --url URL              (required)
  --method M             default GET
  --header "K: V"        repeatable
  --body STRING          for POST etc
  --wordlist PATH        custom list (one name per line; default: built-in)
  --rate-limit N         req/s, default 10
  --timeout MS           default 12000
  --allow-private        allow private/loopback

Output:
  default                ranked table
  --json                 structured

`)
  process.exit(code)
}
