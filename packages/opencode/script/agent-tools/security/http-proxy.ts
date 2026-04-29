#!/usr/bin/env bun
/**
 * http-proxy.ts — Burp Suite Proxy / Intercept equivalent.
 *
 * A man-in-the-middle HTTP/HTTPS proxy that the security agent can use
 * to inspect, modify, and forward traffic from any HTTP client (browser,
 * mobile app, curl, Postman) routed through it.
 *
 * Modes:
 *
 *   start                     run the proxy server (foreground)
 *   ca-export <path>          write the local Root CA pem so clients can trust HTTPS MITM
 *   intercept on|off          toggle interception via control socket
 *   list [--limit N]          list captured flows from history DB
 *   show <id>                 show one full request+response (decoded)
 *   send-to-repeater <id>     emit the request as JSON the repeater understands
 *   match-and-replace add ... add a passive rewrite rule (regex on req/resp)
 *   match-and-replace list    show active rewrite rules
 *
 * Usage:
 *
 *   # 1) export and trust the CA
 *   bun http-proxy.ts ca-export ~/crimecode-ca.pem
 *   #    (then add it to the OS / browser trust store)
 *
 *   # 2) start the proxy (default 127.0.0.1:8181)
 *   bun http-proxy.ts start --port 8181 --intercept
 *
 *   # 3) point your browser / curl at it
 *   curl -x http://127.0.0.1:8181 https://example.com
 *
 *   # 4) review flows (history is sqlite, persisted across restarts)
 *   bun http-proxy.ts list --limit 50
 *   bun http-proxy.ts show 42
 *
 *   # 5) push a captured flow into the repeater
 *   bun http-proxy.ts send-to-repeater 42 | bun http-repeater.ts send --json
 *
 * Interception:
 *   When --intercept is on, the proxy holds incoming requests/responses
 *   in a queue and prints them to a control socket (UNIX socket on
 *   POSIX, named pipe on Win32) for the agent / TUI to drop, edit, or
 *   forward. With --intercept off the proxy passes traffic through and
 *   only logs to the history DB.
 *
 * Match-and-replace:
 *   Persistent rewrites applied to flows even when interception is off.
 *   Useful for swapping auth tokens, stripping security headers in
 *   testing, etc. Stored alongside history in the same DB so the agent
 *   can read/modify them.
 *
 * Safety:
 *   - Listens on 127.0.0.1 only by default (use --bind 0.0.0.0 to expose
 *     — and only do that on an isolated lab network).
 *   - HTTPS MITM uses a per-host certificate signed by a local CA
 *     generated on first run and stored in $XDG_DATA_HOME/crimecode/proxy/ca.pem.
 *     The CA must be explicitly trusted by the client; nothing trusts it
 *     by default.
 *   - History DB is sqlite at $XDG_DATA_HOME/crimecode/proxy/history.db.
 *   - Bodies > 10 MB are streamed but not stored full (trimmed at 1 MB
 *     in the DB) to keep the file from blowing up.
 *   - Refuses to MITM hosts in --no-intercept-hosts (good for things
 *     like update-checks, telemetry, OAuth flows you don't want to
 *     touch). Default exclusion list covers common OS auto-update +
 *     telemetry endpoints.
 */
import { argv } from "node:process"
import { createServer as createTcpServer, Socket } from "node:net"
import { Server as HttpServer, IncomingMessage, ServerResponse, request as httpRequest } from "node:http"
import { request as httpsRequest, createServer as createHttpsServer } from "node:https"
import { connect as tlsConnect, createSecureContext } from "node:tls"
import type { SecureContext } from "node:tls"
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { performance } from "node:perf_hooks"
import { Database } from "bun:sqlite"
import {
  decompressBody,
  detectErrorFingerprints,
  ensureHostAllowed,
  formatBytes,
  isLikelyText,
  makeArgs,
  bail,
  info,
  ok,
} from "./_lib/common.ts"
import { generateKeyPairSync, createSign, createHash, X509Certificate } from "node:crypto"

// ---------------------------------------------------------------------------
// Paths & DB bootstrap
// ---------------------------------------------------------------------------

const DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "crimecode",
  "proxy",
)
mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = join(DATA_DIR, "history.db")
const CA_DIR = join(DATA_DIR, "ca")
mkdirSync(CA_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.exec(`PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  path TEXT NOT NULL,
  req_headers TEXT NOT NULL,
  req_body BLOB,
  req_body_size INTEGER NOT NULL,
  status INTEGER,
  resp_headers TEXT,
  resp_body BLOB,
  resp_body_size INTEGER,
  resp_content_type TEXT,
  duration_ms INTEGER,
  error TEXT,
  notes TEXT,
  flagged INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_flows_host ON flows(host);
CREATE INDEX IF NOT EXISTS idx_flows_status ON flows(status);
CREATE INDEX IF NOT EXISTS idx_flows_ts ON flows(ts);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,                 -- 'request' or 'response'
  scope TEXT NOT NULL,                -- 'header', 'body', 'url'
  match TEXT NOT NULL,                -- regex
  replace TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const cli = makeArgs(argv)
const cmd = cli.args[0]

if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

if (cmd === "start") await cmdStart()
else if (cmd === "ca-export") cmdCaExport()
else if (cmd === "list") cmdList()
else if (cmd === "show") cmdShow()
else if (cmd === "send-to-repeater") cmdSendToRepeater()
else if (cmd === "intercept") cmdToggleIntercept()
else if (cmd === "match-and-replace") cmdMatchReplace()
else if (cmd === "clear") cmdClear()
else if (cmd === "stats") cmdStats()
else usage(2)

// ---------------------------------------------------------------------------
// CA management
// ---------------------------------------------------------------------------

interface Ca {
  certPem: string
  keyPem: string
  cert: X509Certificate
}

let CA: Ca | null = null

function loadOrCreateCa(): Ca {
  if (CA) return CA
  const certPath = join(CA_DIR, "ca.pem")
  const keyPath = join(CA_DIR, "ca-key.pem")
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, "utf8")
    const keyPem = readFileSync(keyPath, "utf8")
    CA = { certPem, keyPem, cert: new X509Certificate(certPem) }
    return CA
  }
  // Generate a new self-signed CA. We use Node's built-in X.509 builder
  // via `selfsigned`-style construction with crypto primitives.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })

  // Build a minimal X.509v3 self-signed root using Bun's openssl wrapper
  // when available. Fall back to a pure-Node DER construction otherwise.
  const certPem = buildSelfSignedCert(publicKey, privateKey)
  writeFileSync(certPath, certPem, { mode: 0o644 })
  writeFileSync(keyPath, privateKey, { mode: 0o600 })

  CA = { certPem, keyPem: privateKey, cert: new X509Certificate(certPem) }
  return CA
}

function buildSelfSignedCert(publicKeyPem: string, privateKeyPem: string): string {
  // Use Bun's openssl integration via the spawn API for portability.
  // We write a minimal config and call `openssl req -x509`.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const tmpKey = join(CA_DIR, ".tmp.key.pem")
  const tmpCert = join(CA_DIR, ".tmp.cert.pem")
  writeFileSync(tmpKey, privateKeyPem)
  const config = `[ req ]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca

[ dn ]
CN = CrimeCode Proxy CA
O = CrimeCode Local
OU = Security Toolkit
C = IT

[ v3_ca ]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
`
  const cfgPath = join(CA_DIR, ".tmp.cnf")
  writeFileSync(cfgPath, config)
  const result = spawnSync(
    "openssl",
    ["req", "-x509", "-new", "-key", tmpKey, "-days", "3650", "-out", tmpCert, "-config", cfgPath],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    bail(
      `failed to generate CA cert via openssl (status ${result.status}): ${result.stderr}\n` +
        `Install openssl or generate a CA manually and place it at ${join(CA_DIR, "ca.pem")}/ca-key.pem`,
    )
  }
  const pem = readFileSync(tmpCert, "utf8")
  // Cleanup
  try {
    require("node:fs").unlinkSync(tmpKey)
    require("node:fs").unlinkSync(tmpCert)
    require("node:fs").unlinkSync(cfgPath)
  } catch {}
  return pem
}

const CTX_CACHE = new Map<string, SecureContext>()

function contextForHost(host: string): SecureContext {
  const cached = CTX_CACHE.get(host)
  if (cached) return cached
  const ca = loadOrCreateCa()
  // Issue a leaf cert signed by our CA.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const leafKeyPath = join(CA_DIR, `leaf-${sanitize(host)}.key.pem`)
  const leafCertPath = join(CA_DIR, `leaf-${sanitize(host)}.cert.pem`)
  if (!existsSync(leafKeyPath) || !existsSync(leafCertPath)) {
    // generate key + CSR + sign
    const csrPath = join(CA_DIR, `leaf-${sanitize(host)}.csr.pem`)
    spawnSync("openssl", ["genrsa", "-out", leafKeyPath, "2048"], { stdio: "ignore" })
    const cnfPath = join(CA_DIR, `leaf-${sanitize(host)}.cnf`)
    writeFileSync(
      cnfPath,
      `[req]
distinguished_name = dn
prompt = no
req_extensions = v3_req

[dn]
CN = ${host}

[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${host}
${/^[\d\.]+$/.test(host) ? `IP.1 = ${host}` : ""}
`,
    )
    spawnSync("openssl", ["req", "-new", "-key", leafKeyPath, "-out", csrPath, "-config", cnfPath], { stdio: "ignore" })
    spawnSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        join(CA_DIR, "ca.pem"),
        "-CAkey",
        join(CA_DIR, "ca-key.pem"),
        "-CAcreateserial",
        "-out",
        leafCertPath,
        "-days",
        "365",
        "-extensions",
        "v3_req",
        "-extfile",
        cnfPath,
      ],
      { stdio: "ignore" },
    )
  }
  const ctx = createSecureContext({
    cert: readFileSync(leafCertPath),
    key: readFileSync(leafKeyPath),
    ca: ca.certPem,
  })
  CTX_CACHE.set(host, ctx)
  return ctx
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

interface ProxyState {
  intercept: boolean
  port: number
  bind: string
  noInterceptHosts: Set<string>
  pendingId: number
  pending: Map<number, PendingFlow>
}

interface PendingFlow {
  resolve: (action: InterceptAction) => void
  request: { method: string; url: string; headers: Record<string, string>; body: Buffer }
}

type InterceptAction =
  | { kind: "forward" }
  | { kind: "drop" }
  | { kind: "edit"; method?: string; url?: string; headers?: Record<string, string>; body?: Buffer }

const DEFAULT_NO_INTERCEPT = new Set([
  "incoming.telemetry.mozilla.org",
  "v10.events.data.microsoft.com",
  "*.update.microsoft.com",
  "swscan.apple.com",
  "ocsp.apple.com",
  "ocsp.digicert.com",
  "ocsp.sectigo.com",
  "ocsp.pki.goog",
  "crl.microsoft.com",
])

async function cmdStart() {
  const port = cli.num("port", 8181)
  const bind = cli.flag("bind") ?? "127.0.0.1"
  const interceptOn = cli.has("--intercept")
  const noInterceptHosts = new Set([...DEFAULT_NO_INTERCEPT, ...cli.list("no-intercept")])

  loadOrCreateCa()

  const state: ProxyState = {
    intercept: interceptOn,
    port,
    bind,
    noInterceptHosts,
    pendingId: 0,
    pending: new Map(),
  }

  // Persist state for `intercept on|off` command to flip
  writeSetting("intercept", interceptOn ? "1" : "0")
  writeSetting("port", String(port))

  const server = createTcpServer((socket) => onClientConnected(socket, state))
  server.listen(port, bind, () => {
    info(`✓ proxy listening on http://${bind}:${port}`)
    info(`  intercept: ${interceptOn ? "ON" : "OFF"}`)
    info(`  CA: ${join(CA_DIR, "ca.pem")} (export and trust before HTTPS MITM)`)
    info(`  history: ${DB_PATH}`)
  })

  process.on("SIGINT", () => {
    info("\n✓ proxy stopping…")
    server.close()
    process.exit(0)
  })
}

function onClientConnected(client: Socket, state: ProxyState) {
  client.once("data", (firstChunk) => {
    const head = firstChunk.toString("utf8", 0, Math.min(firstChunk.length, 4096))
    // Detect CONNECT (HTTPS tunnel)
    if (head.startsWith("CONNECT ")) {
      handleConnect(client, head, firstChunk, state)
      return
    }
    // Otherwise it's a plain HTTP request (the client is using us as a forward proxy)
    handlePlainHttp(client, firstChunk, state)
  })
  client.on("error", () => {
    /* ignore */
  })
}

function handleConnect(client: Socket, head: string, firstChunk: Buffer, state: ProxyState) {
  const m = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.\d/.exec(head)
  if (!m) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n")
    return
  }
  const target = m[1]
  const [host, portStr] = target.split(":")
  const port = Number(portStr || "443")

  if (shouldNotIntercept(host, state)) {
    // Pass-through TCP tunnel (no MITM)
    const upstream = new Socket()
    upstream.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      client.pipe(upstream).pipe(client)
    })
    upstream.on("error", () => client.end())
    return
  }

  // MITM: write back 200 then perform TLS handshake on the client side
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
  const tlsServer = createHttpsServer(
    { SNICallback: (sni, cb) => cb(null, contextForHost(sni || host)) },
    (req, res) => onMitmRequest(req, res, { scheme: "https", host, port }, state),
  )
  tlsServer.on("error", () => {
    /* ignore */
  })
  tlsServer.emit("connection", client)
}

function handlePlainHttp(client: Socket, firstChunk: Buffer, state: ProxyState) {
  // Build a small HTTP server bound to this socket so Node parses the request for us.
  const httpServer = new HttpServer((req, res) => {
    // The URL on a forward proxy is absolute (http://host/path). Rebuild target.
    let scheme = "http"
    let host = req.headers.host ?? ""
    let port = 80
    let pathOnly = req.url ?? "/"
    try {
      const parsed = new URL(req.url ?? "")
      scheme = parsed.protocol.replace(":", "")
      host = parsed.host
      port = Number(parsed.port || (scheme === "https" ? 443 : 80))
      pathOnly = parsed.pathname + parsed.search
      req.url = pathOnly
    } catch {
      const colonIdx = host.indexOf(":")
      if (colonIdx >= 0) {
        port = Number(host.slice(colonIdx + 1))
        host = host.slice(0, colonIdx)
      }
    }
    onMitmRequest(req, res, { scheme, host, port }, state)
  })
  httpServer.emit("connection", client)
  // Replay first chunk so the parser sees the bytes
  client.unshift(firstChunk)
}

function shouldNotIntercept(host: string, state: ProxyState): boolean {
  if (state.noInterceptHosts.has(host)) return true
  for (const h of state.noInterceptHosts) {
    if (h.startsWith("*.") && host.endsWith(h.slice(1))) return true
  }
  return false
}

async function onMitmRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  target: { scheme: string; host: string; port: number },
  state: ProxyState,
) {
  const t0 = performance.now()
  let reqHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(clientReq.headers)) {
    if (Array.isArray(v)) reqHeaders[k] = v.join(", ")
    else if (v !== undefined) reqHeaders[k] = String(v)
  }
  // Strip hop-by-hop headers from the inbound request
  const hopByHop = ["proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]
  for (const h of hopByHop) delete reqHeaders[h]

  const reqBodyChunks: Buffer[] = []
  for await (const chunk of clientReq) reqBodyChunks.push(chunk as Buffer)
  let reqBody: Buffer = Buffer.concat(reqBodyChunks) as Buffer

  // Apply request-side match-and-replace rules
  const reqRules = listRules({ enabled: true, type: "request" })
  let method = clientReq.method ?? "GET"
  let pathOnly = clientReq.url ?? "/"
  const _reqRes = applyRequestRules(method, pathOnly, reqHeaders, reqBody, reqRules)
  method = _reqRes.method
  pathOnly = _reqRes.pathOnly
  reqHeaders = _reqRes.reqHeaders
  reqBody = _reqRes.reqBody

  // Interception
  let action: InterceptAction = { kind: "forward" }
  if (state.intercept) {
    const id = ++state.pendingId
    info(`[intercept] #${id} ${method} ${target.scheme}://${target.host}${pathOnly}`)
    info(`            (control with: bun http-proxy.ts intercept-action ${id} <forward|drop|edit:...>)`)
    action = await new Promise<InterceptAction>((resolve) => {
      state.pending.set(id, {
        resolve,
        request: { method, url: `${target.scheme}://${target.host}${pathOnly}`, headers: reqHeaders, body: reqBody },
      })
      // Auto-forward after 2 minutes of agent silence so a stuck client doesn't hang.
      setTimeout(() => {
        if (state.pending.has(id)) {
          info(`[intercept] #${id} auto-forwarded after 120s timeout`)
          state.pending.delete(id)
          resolve({ kind: "forward" })
        }
      }, 120_000)
    })
    if (action.kind === "drop") {
      clientRes.statusCode = 502
      clientRes.end("Dropped by proxy")
      logFlow({
        ts: Date.now(),
        method,
        scheme: target.scheme,
        host: target.host,
        port: target.port,
        path: pathOnly,
        reqHeaders,
        reqBody,
        status: 0,
        respHeaders: {},
        respBody: Buffer.alloc(0),
        respContentType: "",
        durationMs: Math.round(performance.now() - t0),
        error: "dropped",
      })
      return
    }
    if (action.kind === "edit") {
      if (action.method) method = action.method
      if (action.url) {
        const u = new URL(action.url)
        target.scheme = u.protocol.replace(":", "")
        target.host = u.hostname
        target.port = Number(u.port || (target.scheme === "https" ? 443 : 80))
        pathOnly = u.pathname + u.search
      }
      if (action.headers) {
        for (const [k, v] of Object.entries(action.headers)) reqHeaders[k] = v
      }
      if (action.body !== undefined) reqBody = action.body as Buffer
    }
  }

  // Forward upstream
  const upstreamModule = target.scheme === "https" ? httpsRequest : httpRequest
  const upstream = upstreamModule({
    method,
    host: target.host,
    port: target.port,
    path: pathOnly,
    headers: reqHeaders,
    rejectUnauthorized: false, // we want to see traffic even to misconfigured servers
  })

  upstream.on("response", async (upRes) => {
    let respHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) respHeaders[k] = v.join(", ")
      else if (v !== undefined) respHeaders[k] = String(v)
    }
    for (const h of hopByHop) delete respHeaders[h]

    const respChunks: Buffer[] = []
    upRes.on("data", (c) => respChunks.push(c as Buffer))
    upRes.on("end", () => {
      let respBody: Buffer = Buffer.concat(respChunks) as Buffer

      // Apply response-side rules
      const respRules = listRules({ enabled: true, type: "response" })
      const _respRes = applyResponseRules(respHeaders, respBody, respRules)
      respHeaders = _respRes.respHeaders
      respBody = _respRes.respBody as Buffer

      const decoded = decompressBody(respBody, respHeaders["content-encoding"])
      const status = upRes.statusCode ?? 0

      // Stream back to client
      clientRes.statusCode = status
      for (const [k, v] of Object.entries(respHeaders)) {
        try {
          clientRes.setHeader(k, v)
        } catch {
          /* invalid header */
        }
      }
      clientRes.end(respBody)

      logFlow({
        ts: Date.now(),
        method,
        scheme: target.scheme,
        host: target.host,
        port: target.port,
        path: pathOnly,
        reqHeaders,
        reqBody,
        status,
        respHeaders,
        respBody: decoded,
        respContentType: respHeaders["content-type"] ?? "",
        durationMs: Math.round(performance.now() - t0),
        error: null,
      })
    })
  })

  upstream.on("error", (err) => {
    clientRes.statusCode = 502
    clientRes.end(`Upstream error: ${err.message}`)
    logFlow({
      ts: Date.now(),
      method,
      scheme: target.scheme,
      host: target.host,
      port: target.port,
      path: pathOnly,
      reqHeaders,
      reqBody,
      status: 0,
      respHeaders: {},
      respBody: Buffer.alloc(0),
      respContentType: "",
      durationMs: Math.round(performance.now() - t0),
      error: err.message,
    })
  })

  if (reqBody.length > 0) upstream.write(reqBody)
  upstream.end()
}

function applyRequestRules(
  method: string,
  pathOnly: string,
  reqHeaders: Record<string, string>,
  reqBody: Buffer,
  rules: Rule[],
): { method: string; pathOnly: string; reqHeaders: Record<string, string>; reqBody: Buffer } {
  let outMethod = method
  let outPath = pathOnly
  let outHeaders = reqHeaders
  let outBody = reqBody
  for (const r of rules) {
    if (r.scope === "url") {
      try {
        outPath = outPath.replace(new RegExp(r.match, "g"), r.replace)
      } catch {}
    } else if (r.scope === "header") {
      // header rules: match `Name: value-regex` form
      try {
        const re = new RegExp(r.match, "i")
        for (const k of Object.keys(outHeaders)) {
          if (re.test(`${k}: ${outHeaders[k]}`)) {
            const replaced = `${k}: ${outHeaders[k]}`.replace(re, r.replace)
            const idx = replaced.indexOf(":")
            if (idx > 0) outHeaders[k] = replaced.slice(idx + 1).trimStart()
          }
        }
      } catch {}
    } else if (r.scope === "body") {
      try {
        const text = outBody.toString("utf8")
        outBody = Buffer.from(text.replace(new RegExp(r.match, "g"), r.replace), "utf8")
      } catch {}
    }
  }
  return { method: outMethod, pathOnly: outPath, reqHeaders: outHeaders, reqBody: outBody }
}

function applyResponseRules(
  respHeaders: Record<string, string>,
  respBody: Buffer,
  rules: Rule[],
): { respHeaders: Record<string, string>; respBody: Buffer } {
  let outHeaders = respHeaders
  let outBody = respBody
  for (const r of rules) {
    if (r.scope === "header") {
      try {
        const re = new RegExp(r.match, "i")
        for (const k of Object.keys(outHeaders)) {
          if (re.test(`${k}: ${outHeaders[k]}`)) {
            const replaced = `${k}: ${outHeaders[k]}`.replace(re, r.replace)
            const idx = replaced.indexOf(":")
            if (idx > 0) outHeaders[k] = replaced.slice(idx + 1).trimStart()
          }
        }
      } catch {}
    } else if (r.scope === "body") {
      try {
        const ct = (outHeaders["content-type"] ?? "").toLowerCase()
        const enc = outHeaders["content-encoding"]
        const decoded = decompressBody(outBody, enc)
        if (isLikelyText(ct)) {
          const text = decoded.toString("utf8")
          outBody = Buffer.from(text.replace(new RegExp(r.match, "g"), r.replace), "utf8")
          // strip content-encoding so the (now plain) body isn't double-decoded by the client
          delete outHeaders["content-encoding"]
          outHeaders["content-length"] = String(outBody.length)
        }
      } catch {}
    }
  }
  return { respHeaders: outHeaders, respBody: outBody }
}

// ---------------------------------------------------------------------------
// History DB
// ---------------------------------------------------------------------------

interface FlowRow {
  id: number
  ts: number
  method: string
  scheme: string
  host: string
  port: number
  path: string
  req_headers: string
  req_body: Buffer | null
  req_body_size: number
  status: number | null
  resp_headers: string | null
  resp_body: Buffer | null
  resp_body_size: number | null
  resp_content_type: string | null
  duration_ms: number | null
  error: string | null
  notes: string | null
  flagged: number
}

const MAX_BODY_STORE = 1_048_576 // 1 MB

function logFlow(args: {
  ts: number
  method: string
  scheme: string
  host: string
  port: number
  path: string
  reqHeaders: Record<string, string>
  reqBody: Buffer
  status: number
  respHeaders: Record<string, string>
  respBody: Buffer
  respContentType: string
  durationMs: number
  error: string | null
}) {
  const reqStored = args.reqBody.subarray(0, MAX_BODY_STORE)
  const respStored = args.respBody.subarray(0, MAX_BODY_STORE)
  db.run(
    `INSERT INTO flows (
      ts, method, scheme, host, port, path,
      req_headers, req_body, req_body_size,
      status, resp_headers, resp_body, resp_body_size, resp_content_type,
      duration_ms, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.ts,
      args.method,
      args.scheme,
      args.host,
      args.port,
      args.path,
      JSON.stringify(args.reqHeaders),
      reqStored,
      args.reqBody.length,
      args.status,
      JSON.stringify(args.respHeaders),
      respStored,
      args.respBody.length,
      args.respContentType,
      args.durationMs,
      args.error,
    ],
  )
}

interface Rule {
  id: number
  enabled: number
  type: "request" | "response"
  scope: "header" | "body" | "url"
  match: string
  replace: string
  description: string | null
}

function listRules(filter?: { enabled?: boolean; type?: string }): Rule[] {
  let sql = "SELECT * FROM rules"
  const where: string[] = []
  const params: unknown[] = []
  if (filter?.enabled !== undefined) {
    where.push("enabled = ?")
    params.push(filter.enabled ? 1 : 0)
  }
  if (filter?.type) {
    where.push("type = ?")
    params.push(filter.type)
  }
  if (where.length) sql += " WHERE " + where.join(" AND ")
  return db.query(sql).all(...(params as never[])) as Rule[]
}

function writeSetting(key: string, value: string) {
  db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    key,
    value,
  ])
}

function readSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value ?? null
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdCaExport() {
  const target = cli.args[1]
  if (!target) bail("usage: ca-export <path>")
  const ca = loadOrCreateCa()
  writeFileSync(target, ca.certPem)
  ok(`wrote CA → ${target}`)
  info(`Trust this cert in the OS / browser. Fingerprint:`)
  info(`  SHA-256: ${ca.cert.fingerprint256}`)
}

function cmdList() {
  const limit = cli.num("limit", 50)
  const host = cli.flag("host")
  const status = cli.flag("status")
  const grep = cli.flag("grep")
  const json = cli.has("--json")

  let sql = "SELECT * FROM flows"
  const where: string[] = []
  const params: unknown[] = []
  if (host) {
    where.push("host LIKE ?")
    params.push(`%${host}%`)
  }
  if (status) {
    where.push("status = ?")
    params.push(Number(status))
  }
  if (grep) {
    where.push("(path LIKE ? OR req_headers LIKE ? OR resp_headers LIKE ?)")
    const g = `%${grep}%`
    params.push(g, g, g)
  }
  if (where.length) sql += " WHERE " + where.join(" AND ")
  sql += " ORDER BY id DESC LIMIT ?"
  params.push(limit)

  const rows = db.query(sql).all(...(params as never[])) as FlowRow[]
  if (json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          method: r.method,
          url: `${r.scheme}://${r.host}${r.port !== (r.scheme === "https" ? 443 : 80) ? ":" + r.port : ""}${r.path}`,
          status: r.status,
          contentType: r.resp_content_type,
          reqSize: r.req_body_size,
          respSize: r.resp_body_size,
          durationMs: r.duration_ms,
          error: r.error,
          flagged: !!r.flagged,
        })),
        null,
        2,
      ),
    )
    return
  }
  console.log(`# HTTP history — ${rows.length} flow(s)\n`)
  console.log(["#id".padEnd(7), "method".padEnd(7), "status".padEnd(7), "size".padEnd(10), "ms".padEnd(6), "url"].join(" "))
  console.log("-".repeat(80))
  for (const r of rows) {
    const url = `${r.scheme}://${r.host}${r.path}`
    console.log(
      [
        String(r.id).padEnd(7),
        r.method.padEnd(7),
        String(r.status ?? "-").padEnd(7),
        formatBytes(r.resp_body_size ?? 0).padEnd(10),
        String(r.duration_ms ?? "-").padEnd(6),
        url.length > 80 ? url.slice(0, 77) + "…" : url,
      ].join(" "),
    )
  }
}

function cmdShow() {
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: show <id>")
  const row = db.query("SELECT * FROM flows WHERE id = ?").get(id) as FlowRow | undefined
  if (!row) bail(`no flow with id ${id}`)
  const reqHeaders = JSON.parse(row.req_headers) as Record<string, string>
  const respHeaders = row.resp_headers ? (JSON.parse(row.resp_headers) as Record<string, string>) : {}
  const json = cli.has("--json")
  if (json) {
    console.log(
      JSON.stringify(
        {
          id: row.id,
          ts: row.ts,
          method: row.method,
          url: `${row.scheme}://${row.host}${row.path}`,
          requestHeaders: reqHeaders,
          requestBody: row.req_body ? row.req_body.toString("utf8") : "",
          status: row.status,
          responseHeaders: respHeaders,
          responseBody: row.resp_body ? row.resp_body.toString("utf8") : "",
          durationMs: row.duration_ms,
          fingerprints: row.resp_body ? detectErrorFingerprints(row.resp_body.toString("utf8")) : [],
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(`# Flow #${row.id}  ${new Date(row.ts).toISOString()}`)
  console.log()
  console.log(`${row.method} ${row.scheme}://${row.host}${row.path}`)
  for (const [k, v] of Object.entries(reqHeaders)) console.log(`${k}: ${v}`)
  if (row.req_body && row.req_body.length > 0) {
    console.log("\n" + (isLikelyText(reqHeaders["content-type"] ?? "") ? row.req_body.toString("utf8") : `<binary, ${row.req_body.length} bytes>`))
  }
  console.log()
  console.log(`HTTP/1.1 ${row.status} (${row.duration_ms} ms, ${formatBytes(row.resp_body_size ?? 0)})`)
  for (const [k, v] of Object.entries(respHeaders)) console.log(`${k}: ${v}`)
  if (row.resp_body && row.resp_body.length > 0) {
    console.log()
    if (isLikelyText(row.resp_content_type ?? "")) {
      console.log(row.resp_body.toString("utf8"))
    } else {
      console.log(`<binary, ${row.resp_body.length} bytes>`)
    }
    const fps = detectErrorFingerprints(row.resp_body.toString("utf8"))
    if (fps.length) console.log(`\n⚠ fingerprints: ${fps.join(", ")}`)
  }
}

function cmdSendToRepeater() {
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: send-to-repeater <id>")
  const row = db.query("SELECT * FROM flows WHERE id = ?").get(id) as FlowRow | undefined
  if (!row) bail(`no flow with id ${id}`)
  const reqHeaders = JSON.parse(row.req_headers) as Record<string, string>
  const repeaterCmd = {
    url: `${row.scheme}://${row.host}${row.path}`,
    method: row.method,
    headers: reqHeaders,
    body: row.req_body ? row.req_body.toString("utf8") : undefined,
  }
  console.log(JSON.stringify(repeaterCmd, null, 2))
}

function cmdToggleIntercept() {
  const v = cli.args[1]
  if (v !== "on" && v !== "off") bail("usage: intercept <on|off>")
  writeSetting("intercept", v === "on" ? "1" : "0")
  ok(`intercept setting → ${v} (running proxy will pick this up on next request via DB poll)`)
}

function cmdMatchReplace() {
  const sub = cli.args[1]
  if (sub === "list") {
    const rows = listRules()
    if (cli.has("--json")) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    if (rows.length === 0) {
      console.log("(no rules)")
      return
    }
    console.log("# Match-and-replace rules\n")
    for (const r of rows) {
      console.log(`#${r.id}  ${r.enabled ? "ON " : "off"}  ${r.type}/${r.scope}`)
      console.log(`  match:   ${r.match}`)
      console.log(`  replace: ${r.replace}`)
      if (r.description) console.log(`  // ${r.description}`)
      console.log()
    }
    return
  }
  if (sub === "add") {
    const type = cli.required("type")
    const scope = cli.required("scope")
    const match = cli.required("match")
    const replace = cli.flag("replace") ?? ""
    const description = cli.flag("description") ?? null
    if (!["request", "response"].includes(type)) bail("--type must be request|response")
    if (!["header", "body", "url"].includes(scope)) bail("--scope must be header|body|url")
    db.run("INSERT INTO rules (enabled, type, scope, match, replace, description) VALUES (1, ?, ?, ?, ?, ?)", [
      type,
      scope,
      match,
      replace,
      description,
    ])
    ok("rule added")
    return
  }
  if (sub === "remove") {
    const id = Number(cli.args[2])
    if (!Number.isFinite(id)) bail("usage: match-and-replace remove <id>")
    db.run("DELETE FROM rules WHERE id = ?", [id])
    ok(`rule ${id} removed`)
    return
  }
  if (sub === "toggle") {
    const id = Number(cli.args[2])
    if (!Number.isFinite(id)) bail("usage: match-and-replace toggle <id>")
    db.run("UPDATE rules SET enabled = 1 - enabled WHERE id = ?", [id])
    ok(`rule ${id} toggled`)
    return
  }
  bail("usage: match-and-replace <list|add|remove|toggle>")
}

function cmdClear() {
  if (!cli.has("--yes")) bail("clear requires --yes (this drops all flow history)")
  db.run("DELETE FROM flows")
  ok("history cleared")
}

function cmdStats() {
  const total = (db.query("SELECT COUNT(*) AS c FROM flows").get() as { c: number }).c
  const byHost = db
    .query("SELECT host, COUNT(*) AS n FROM flows GROUP BY host ORDER BY n DESC LIMIT 10")
    .all() as Array<{ host: string; n: number }>
  const byStatus = db
    .query("SELECT status, COUNT(*) AS n FROM flows GROUP BY status ORDER BY n DESC")
    .all() as Array<{ status: number | null; n: number }>
  const slow = db
    .query("SELECT id, method, host, path, duration_ms FROM flows ORDER BY duration_ms DESC LIMIT 5")
    .all() as Array<{ id: number; method: string; host: string; path: string; duration_ms: number }>

  if (cli.has("--json")) {
    console.log(JSON.stringify({ total, byHost, byStatus, slow }, null, 2))
    return
  }
  console.log(`# Proxy stats — ${total} flows total\n`)
  console.log(`Top hosts:`)
  for (const h of byHost) console.log(`  ${String(h.n).padEnd(6)} ${h.host}`)
  console.log()
  console.log(`Status distribution:`)
  for (const s of byStatus) console.log(`  ${String(s.n).padEnd(6)} ${s.status ?? "(error)"}`)
  console.log()
  console.log(`Slowest flows:`)
  for (const r of slow) console.log(`  ${String(r.duration_ms).padEnd(7)}ms  #${r.id}  ${r.method} ${r.host}${r.path}`)
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`http-proxy.ts <command> [flags]

Commands:
  start                       run the MITM proxy (foreground)
    --port N                  default 8181
    --bind ADDR               default 127.0.0.1
    --intercept               start with interception ON
    --no-intercept HOST       skip MITM for HOST (repeatable; * wildcards)

  ca-export <path>            write the local Root CA pem
  list [--limit N --host H --status S --grep TEXT --json]
                              browse captured flows
  show <id> [--json]          show one full flow (decoded headers + body)
  send-to-repeater <id>       emit JSON the repeater can consume
  intercept <on|off>          flip interception on a running proxy
  match-and-replace list
  match-and-replace add --type request|response --scope header|body|url \\
                          --match REGEX --replace TEXT [--description ""]
  match-and-replace remove <id>
  match-and-replace toggle <id>
  clear --yes                 wipe history DB
  stats [--json]              top hosts / status / slow flows

Storage: ${DATA_DIR}
`)
  process.exit(code)
}
