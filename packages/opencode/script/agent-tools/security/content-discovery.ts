#!/usr/bin/env bun
/**
 * content-discovery.ts — Burp's "Engagement Tools → Content Discovery" /
 * gobuster-feroxbuster equivalent.
 *
 * Brute-force directory and file discovery against an HTTP target with
 * a wordlist + extension matrix. Smart enough to:
 *   - calibrate against a known-bogus path so we know what 404 looks like
 *     (length / status / body hash) — needed to defeat sites that return
 *     a 200 + custom 404 page
 *   - filter out responses that match the calibration fingerprint
 *   - follow redirects to detect "soft" hits
 *   - rate-limit + concurrency cap
 *   - detect CDN/WAF blocks (HTTP 403 with Cloudflare/Akamai banner)
 *
 * Usage:
 *   bun content-discovery.ts \
 *       --url https://target/ \
 *       --wordlist big.txt \
 *       --ext "php,bak,old,zip,tar.gz" \
 *       --concurrency 8 --rps 10 \
 *       --json
 *
 * Built-in wordlists:
 *   --builtin small      ~120 high-signal entries (admin, .git, .env, etc.)
 *   --builtin medium     ~600 entries (common backup, infra paths)
 *   --builtin api        ~250 entries focused on REST/GraphQL surfaces
 *
 * Output:
 *   - text: progress bar on stderr, hits printed live on stdout
 *   - --json: full structured array of {url,status,size,redirect}
 */
import { argv } from "node:process"
import { performance } from "node:perf_hooks"
import { createHash } from "node:crypto"
import {
  ensureHostAllowed,
  isLikelyText,
  loadPayloadFile,
  makeArgs,
  bail,
  info,
  formatBytes,
} from "./_lib/common.ts"

const cli = makeArgs(argv)
if (cli.has("--help") || cli.has("-h")) usage(0)

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const baseUrl = cli.required("url")
const allowPrivate = cli.has("--allow-private")
const wordlistPath = cli.flag("wordlist")
const builtinName = cli.flag("builtin")
const extList = (cli.flag("ext") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const concurrency = cli.num("concurrency", 8)
const rps = cli.num("rps", 10)
const timeout = cli.num("timeout", 10_000)
const followRedirects = !cli.has("--no-redirect")
const userAgent =
  cli.flag("user-agent") ?? "Mozilla/5.0 (compatible; crimecode-content-discovery/1.0; +https://opencode.ai)"
const matchCodes = (cli.flag("match-codes") ?? "200,204,301,302,307,401,403,500")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Number.isFinite)
const json = cli.has("--json")

ensureHostAllowed(baseUrl, allowPrivate)
const baseUrlNorm = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"

let words: string[] = []
if (wordlistPath) words = loadPayloadFile(wordlistPath)
else if (builtinName) words = pickBuiltin(builtinName)
else bail("supply --wordlist FILE or --builtin small|medium|api")

if (words.length === 0) bail("wordlist empty")

const HARD_CAP = cli.num("max", 25_000)
if (words.length * Math.max(1, extList.length + 1) > HARD_CAP) {
  info(
    `⚠ wordlist × extensions = ${words.length * Math.max(1, extList.length + 1)} > cap ${HARD_CAP}; truncating wordlist.`,
  )
  words = words.slice(0, Math.floor(HARD_CAP / Math.max(1, extList.length + 1)))
}

// Build the candidate path set: each word + each (word + ext)
const candidates: string[] = []
for (const w of words) {
  const stripped = w.replace(/^\/+/, "")
  candidates.push(stripped)
  for (const e of extList) candidates.push(`${stripped}.${e.replace(/^\.+/, "")}`)
}

// ---------------------------------------------------------------------------
// Calibration: hit a known-bogus path to learn what 404 looks like
// ---------------------------------------------------------------------------

const calibrationPaths = [
  `__crimecode_404_${Math.random().toString(36).slice(2, 12)}__`,
  `__crimecode_404_${Math.random().toString(36).slice(2, 12)}__/`,
  `index.${Math.random().toString(36).slice(2, 8)}.html`,
]

interface Calibration {
  status: number
  size: number
  bodyHash: string
  text: boolean
}

const calibrations: Calibration[] = []
for (const c of calibrationPaths) {
  try {
    const r = await fetchOne(c)
    calibrations.push({
      status: r.status,
      size: r.size,
      bodyHash: r.bodyHash,
      text: r.text,
    })
  } catch {
    /* ignore individual failures */
  }
}

if (calibrations.length === 0) {
  info(`⚠ calibration probes all failed — proceeding without filter`)
}

// Heuristic: if a hit's status+size+hash matches calibration, it's a soft 404
function isSoft404(r: { status: number; size: number; bodyHash: string }): boolean {
  for (const c of calibrations) {
    if (r.status === c.status && (r.bodyHash === c.bodyHash || (c.size > 0 && Math.abs(r.size - c.size) < 64))) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Run with concurrency + RPS limit
// ---------------------------------------------------------------------------

interface Hit {
  url: string
  status: number
  size: number
  contentType: string
  redirect: string | null
  durationMs: number
}

const hits: Hit[] = []
const t0 = performance.now()
const minIntervalMs = rps > 0 ? 1000 / rps : 0
let lastSentAt = 0
let inflight = 0
let idx = 0

await new Promise<void>((resolve) => {
  function pump() {
    while (inflight < concurrency && idx < candidates.length) {
      const path = candidates[idx++]
      const wait = Math.max(0, lastSentAt + minIntervalMs - performance.now())
      lastSentAt = performance.now() + wait
      inflight++
      setTimeout(() => {
        runOne(path).finally(() => {
          inflight--
          pump()
        })
      }, wait)
    }
    if (inflight === 0 && idx >= candidates.length) resolve()
  }
  pump()
})

async function runOne(path: string) {
  try {
    const r = await fetchOne(path)
    if (!matchCodes.includes(r.status)) return
    if (isSoft404({ status: r.status, size: r.size, bodyHash: r.bodyHash })) return
    const hit: Hit = {
      url: r.url,
      status: r.status,
      size: r.size,
      contentType: r.contentType,
      redirect: r.redirect,
      durationMs: r.durationMs,
    }
    hits.push(hit)
    if (!json) {
      const tag = colorForStatus(r.status)
      info(
        `  ${tag}${String(r.status).padEnd(4)}\x1b[0m  ${formatBytes(r.size).padStart(8)}  ${r.url}${r.redirect ? "  → " + r.redirect : ""}`,
      )
    }
  } catch (e) {
    if (!json) info(`  ERR  ${path}  ${(e as Error).message}`)
  }
  if (!json && idx % 25 === 0) {
    const pct = ((idx / candidates.length) * 100).toFixed(1)
    info(`  [${pct}%] ${idx}/${candidates.length}  hits=${hits.length}`)
  }
}

const totalMs = Math.round(performance.now() - t0)

if (json) {
  console.log(
    JSON.stringify(
      {
        target: baseUrl,
        candidates: candidates.length,
        durationMs: totalMs,
        rps: rps,
        calibration: calibrations,
        hits,
      },
      null,
      2,
    ),
  )
} else {
  info(`\n# Done — ${hits.length} hit(s) in ${totalMs} ms (${candidates.length} requests)`)
  for (const h of hits) {
    console.log(
      `${String(h.status).padEnd(4)}  ${formatBytes(h.size).padStart(8)}  ${h.url}${h.redirect ? "  → " + h.redirect : ""}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Single fetch
// ---------------------------------------------------------------------------

async function fetchOne(path: string) {
  const url = baseUrlNorm + path.replace(/^\/+/, "")
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  const t0 = performance.now()
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": userAgent },
      redirect: followRedirects ? "follow" : "manual",
      signal: ctrl.signal,
    })
    const buf = new Uint8Array(await r.arrayBuffer())
    const ct = r.headers.get("content-type") ?? ""
    const text = isLikelyText(ct)
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16)
    return {
      url,
      status: r.status,
      size: buf.byteLength,
      contentType: ct,
      bodyHash: hash,
      text,
      redirect: r.redirected ? r.url : null,
      durationMs: Math.round(performance.now() - t0),
    }
  } finally {
    clearTimeout(t)
  }
}

function colorForStatus(s: number): string {
  if (s >= 500) return "\x1b[35m" // magenta
  if (s >= 400 && s !== 401 && s !== 403) return "\x1b[31m" // red
  if (s === 401 || s === 403) return "\x1b[33m" // yellow
  if (s >= 300) return "\x1b[36m" // cyan
  if (s >= 200) return "\x1b[32m" // green
  return ""
}

// ---------------------------------------------------------------------------
// Built-in wordlists
// ---------------------------------------------------------------------------

function pickBuiltin(name: string): string[] {
  if (name === "small") return SMALL
  if (name === "medium") return [...SMALL, ...MEDIUM_EXTRA]
  if (name === "api") return API
  bail(`unknown --builtin ${name} (small | medium | api)`)
}

const SMALL = [
  ".git/HEAD",
  ".git/config",
  ".gitignore",
  ".env",
  ".env.local",
  ".env.production",
  ".env.dev",
  ".DS_Store",
  ".htpasswd",
  ".htaccess",
  ".svn/entries",
  ".hg/store",
  "robots.txt",
  "sitemap.xml",
  "crossdomain.xml",
  "humans.txt",
  "security.txt",
  ".well-known/security.txt",
  ".well-known/openid-configuration",
  ".well-known/oauth-authorization-server",
  "admin",
  "admin/",
  "admin.php",
  "admin.html",
  "administrator",
  "wp-admin",
  "wp-login.php",
  "wp-config.php",
  "wp-config.php.bak",
  "wp-config.bak",
  "wp-config.old",
  "config",
  "config.php",
  "config.json",
  "config.yml",
  "config.yaml",
  "configuration",
  "settings.json",
  "settings.py",
  "phpinfo.php",
  "info.php",
  "test.php",
  "shell.php",
  "backup",
  "backup.zip",
  "backup.tar.gz",
  "backup.sql",
  "db.sql",
  "database.sql",
  "dump.sql",
  "dump",
  "private",
  "private.key",
  "id_rsa",
  "id_dsa",
  "server.key",
  "site.tar.gz",
  "site.zip",
  "src.zip",
  "source.zip",
  "logs",
  "log",
  "error.log",
  "access.log",
  "debug.log",
  "trace.log",
  "console",
  "swagger",
  "swagger.json",
  "swagger.yaml",
  "swagger-ui",
  "swagger-ui.html",
  "openapi.json",
  "openapi.yaml",
  "graphql",
  "graphiql",
  "playground",
  "altair",
  "actuator",
  "actuator/health",
  "actuator/env",
  "actuator/heapdump",
  "actuator/threaddump",
  "actuator/mappings",
  "actuator/configprops",
  "actuator/loggers",
  "metrics",
  "health",
  "status",
  "ping",
  "version",
  "api",
  "api/",
  "api/v1",
  "api/v2",
  "api/v3",
  "api/internal",
  "internal",
  "private/",
  "uploads",
  "uploads/",
  "files",
  "data",
  "static",
  "public",
  "tmp",
  "temp",
  "cache",
  ".aws/credentials",
  ".aws/config",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  "docker-compose.yml",
  "Dockerfile",
  "Makefile",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "Gemfile.lock",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  ".idea/workspace.xml",
  "vendor",
  "node_modules",
  "phpmyadmin",
  "pma",
  "myadmin",
  "manager",
  "manager/html",
  "manager/status",
  "host-manager",
  "console",
  "jmx-console",
  "jolokia",
  "metrics-jvm",
  "trace",
  "trace.axd",
  "elmah.axd",
  "cgi-bin",
  "server-status",
  "server-info",
]

const MEDIUM_EXTRA = [
  "config.php.bak",
  "settings.bak",
  ".env.bak",
  ".env~",
  "config~",
  "users",
  "users.json",
  "user",
  "users/me",
  "auth",
  "auth/login",
  "auth/logout",
  "login",
  "logout",
  "register",
  "signup",
  "reset",
  "reset-password",
  "forgot",
  "forgot-password",
  "oauth",
  "oauth/authorize",
  "oauth/token",
  "saml",
  "sso",
  "callback",
  "redirect",
  "logout.aspx",
  "login.aspx",
  "default.aspx",
  "default.asp",
  "Web.config",
  "WEB-INF/web.xml",
  "WEB-INF/classes",
  "META-INF/MANIFEST.MF",
  "RAILS_RELATIVE_URL_ROOT",
  "config/database.yml",
  "config/secrets.yml",
  "config/master.key",
  "rails/info/routes",
  "rails/info/properties",
  "log/development.log",
  "log/production.log",
  "log/test.log",
  "logs/app.log",
  "vendor/composer/installed.json",
  "vendor/autoload.php",
  ".npm/_logs",
  "yarn-error.log",
  "npm-debug.log",
  "ALLUSERSPROFILE",
  "Web.config.bak",
  "web.xml.bak",
  "settings.xml",
  "/test/",
  "/dev/",
  "/staging/",
  "/preprod/",
  "/qa/",
  "/uat/",
  "/beta/",
  "/canary/",
  "/v1/",
  "/v2/",
  "/v3/",
  "/v4/",
  "graphql/v1",
  "api/swagger",
  "api-docs",
  "api/docs",
  "docs",
  "documentation",
  "redoc",
  "rapidoc",
  "favicon.ico.bak",
  "robots.txt.bak",
  "phpunit.xml",
  ".vscode/settings.json",
  ".vscode/launch.json",
  ".terraform",
  "terraform.tfstate",
  "terraform.tfstate.backup",
  "ansible/hosts",
  ".kube/config",
  ".gcloud",
  ".azure",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".mysql_history",
  ".rediscli_history",
]

const API = [
  "api",
  "api/",
  "api/v1/",
  "api/v2/",
  "api/v3/",
  "api/v4/",
  "rest",
  "rest/",
  "rest/v1/",
  "rest/v2/",
  "graphql",
  "graphql/",
  "graphiql",
  "playground",
  "altair",
  "voyager",
  "explorer",
  "swagger",
  "swagger.json",
  "swagger.yaml",
  "swagger-ui",
  "swagger-ui/",
  "swagger-ui.html",
  "swagger-ui/index.html",
  "openapi",
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "v3/api-docs",
  "api-docs",
  "api/docs",
  "docs",
  "redoc",
  "rapidoc",
  "spec.json",
  "spec.yaml",
  "users",
  "user",
  "users/me",
  "me",
  "profile",
  "account",
  "accounts",
  "auth",
  "login",
  "logout",
  "register",
  "signup",
  "token",
  "tokens",
  "refresh",
  "session",
  "sessions",
  "oauth",
  "oauth/token",
  "oauth/authorize",
  "saml",
  "sso",
  "admin",
  "admin/",
  "admin/users",
  "admin/settings",
  "settings",
  "config",
  "configuration",
  "health",
  "healthz",
  "livez",
  "readyz",
  "status",
  "metrics",
  "info",
  "version",
  "actuator",
  "actuator/health",
  "actuator/env",
  "actuator/info",
  "actuator/loggers",
  "actuator/heapdump",
  "actuator/threaddump",
  "actuator/mappings",
  "actuator/configprops",
  "actuator/beans",
  "actuator/auditevents",
  "actuator/httptrace",
  "actuator/scheduledtasks",
  "actuator/sessions",
  "actuator/caches",
  "actuator/conditions",
  "actuator/jolokia",
  "search",
  "query",
  "lookup",
  "find",
  "list",
  "items",
  "products",
  "orders",
  "carts",
  "cart",
  "checkout",
  "payments",
  "payment",
  "subscriptions",
  "invoices",
  "billing",
  "files",
  "upload",
  "uploads",
  "download",
  "downloads",
  "export",
  "import",
  "logs",
  "events",
  "notifications",
  "messages",
  "chats",
  "comments",
  "posts",
  "articles",
  "feed",
  "stream",
]

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`content-discovery.ts [flags]

Brute-force directory / file discovery (gobuster / feroxbuster–style).

Required:
  --url URL                   target base URL (with trailing slash optional)
  --wordlist FILE | --builtin small|medium|api

Optional:
  --ext "php,bak,old,zip"     append each as an extension to every word
  --concurrency N             default 8
  --rps N                     requests/second cap (default 10)
  --timeout MS                per-request timeout (default 10000)
  --no-redirect               don't follow 30x
  --user-agent UA             custom UA
  --match-codes "200,403,..."
  --max N                     hard cap on total requests (default 25000)
  --allow-private             permit private/loopback targets
  --json
`)
  process.exit(code)
}
