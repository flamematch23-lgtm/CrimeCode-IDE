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

-- Persistent intercept queue. Rows live for the duration of one HTTP
-- request -- 'status' is 'pending' until the proxy or an external CLI/UI
-- decides forward / drop / edit, then the row is consumed.
CREATE TABLE IF NOT EXISTS pending_intercepts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  proxy_pid INTEGER NOT NULL,
  phase TEXT NOT NULL,                -- 'request' | 'response'
  method TEXT NOT NULL,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  path TEXT NOT NULL,
  headers TEXT NOT NULL,
  body BLOB,
  status TEXT NOT NULL DEFAULT 'pending',
  action TEXT,                        -- forward|drop|edit
  action_payload TEXT,                -- JSON for edit
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_intercepts(status);
`)

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const cli = makeArgs(argv)
// CA state — declared up here (before dispatch) so command handlers that
// touch the CA don't hit a temporal-dead-zone error on Bun.
interface Ca {
  certPem: string
  keyPem: string
  cert: X509Certificate
}
let CA: Ca | null = null
const CTX_CACHE = new Map<string, SecureContext>()

// Telemetry/CRL/OCSP hosts auto-skipped by intercept (noise filter).
// Declared BEFORE the top-level cmd dispatch below, otherwise cmdStart()
// hits a Temporal Dead Zone error (the const is hoisted but uninitialized).
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

const cmd = cli.args[0]

if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

if (cmd === "start") await cmdStart()
else if (cmd === "ca-export") cmdCaExport()
else if (cmd === "list") cmdList()
else if (cmd === "show") cmdShow()
else if (cmd === "send-to-repeater") cmdSendToRepeater()
else if (cmd === "intercept") cmdToggleIntercept()
else if (cmd === "intercept-action") cmdInterceptAction()
else if (cmd === "pending") cmdPending()
else if (cmd === "match-and-replace") cmdMatchReplace()
else if (cmd === "clear") cmdClear()
else if (cmd === "stats") cmdStats()
else usage(2)

// ---------------------------------------------------------------------------
// CA management
// ---------------------------------------------------------------------------

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
  if (result.error || result.status !== 0) {
    const why = result.error
      ? `openssl not on PATH (${(result.error as NodeJS.ErrnoException).code ?? result.error.message})`
      : `openssl exited ${result.status}: ${result.stderr}`
    bail(
      `failed to generate CA cert: ${why}\n` +
        `Install openssl (e.g. https://slproweb.com/products/Win32OpenSSL.html on Windows) or\n` +
        `generate a CA manually and place it at:\n` +
        `  ${join(CA_DIR, "ca.pem")}\n` +
        `  ${join(CA_DIR, "ca-key.pem")}`,
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

// (CTX_CACHE and CA are declared at the top of the file so that they're
// available to command handlers that run synchronously after dispatch.)

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

async function cmdStart() {
  const port = cli.num("port", 8181)
  const bind = cli.flag("bind") ?? "127.0.0.1"
  const interceptOn = cli.has("--intercept")
  const noInterceptHosts = new Set([...DEFAULT_NO_INTERCEPT, ...cli.list("no-intercept")])
  const apiPort = cli.num("api-port", 0) // 0 = disabled
  const apiBind = cli.flag("api-bind") ?? "127.0.0.1"

  // Lazy CA generation: only attempt at startup if a CA already exists, so
  // HTTP-only flows work on hosts without openssl. CONNECT tunnels (HTTPS)
  // will trigger CA creation on demand and surface the openssl error then.
  const caPath = join(CA_DIR, "ca.pem")
  if (existsSync(caPath)) {
    try {
      loadOrCreateCa()
    } catch (e) {
      info(`⚠ failed to load existing CA: ${e instanceof Error ? e.message : String(e)} — HTTPS MITM will fail`)
    }
  } else {
    info(`ℹ no CA at ${caPath}. HTTP traffic will work; HTTPS MITM needs:`)
    info(`     openssl on PATH + first CONNECT request, OR run \`http-proxy.ts ca-export\``)
  }

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
  server.on("error", (err) => {
    bail(`proxy listen failed on ${bind}:${port}: ${err.message}`, 1)
  })
  server.listen(port, bind, () => {
    info(`✓ proxy listening on http://${bind}:${port}`)
    info(`  intercept: ${interceptOn ? "ON" : "OFF"}`)
    info(`  CA: ${join(CA_DIR, "ca.pem")} (export and trust before HTTPS MITM)`)
    info(`  history: ${DB_PATH}`)
    if (bind === "0.0.0.0" || bind === "::") {
      info(
        `\n⚠ WARNING: proxy is listening on ${bind}, exposing it to your local network.\n` +
          `  Anyone on the same network can route HTTP through this proxy.\n` +
          `  Use --bind 127.0.0.1 unless you're on an isolated lab network.`,
      )
    }
  })

  // Optional control API
  let apiServer: ReturnType<typeof startControlApi> | null = null
  if (apiPort > 0) {
    apiServer = startControlApi({ port: apiPort, bind: apiBind })
  }

  process.on("SIGINT", () => {
    info("\n✓ proxy stopping…")
    server.close()
    apiServer?.close()
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

  // Re-read the persisted intercept flag so external `intercept on|off`
  // commands take effect on the running proxy without restart.
  const persistedIntercept = readSetting("intercept")
  if (persistedIntercept !== null) state.intercept = persistedIntercept === "1"

  // Interception — persist to DB so an external CLI / UI / API on the
  // same machine can resolve the pending request.
  let action: InterceptAction = { kind: "forward" }
  if (state.intercept) {
    const dbId = enqueueIntercept({
      phase: "request",
      method,
      scheme: target.scheme,
      host: target.host,
      port: target.port,
      path: pathOnly,
      headers: reqHeaders,
      body: reqBody,
    })
    info(`[intercept] #${dbId} ${method} ${target.scheme}://${target.host}${pathOnly}`)
    info(`            forward: bun http-proxy.ts intercept-action ${dbId} forward`)
    info(`            drop:    bun http-proxy.ts intercept-action ${dbId} drop`)
    action = await waitForInterceptAction(dbId, 120_000)
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
        // Sync Content-Length so upstream doesn't get a truncated body
        // (Transfer-Encoding: chunked requests don't use Content-Length)
        const hasChunked =
          (outHeaders["transfer-encoding"] ?? outHeaders["Transfer-Encoding"] ?? "").toLowerCase() === "chunked"
        if (!hasChunked) {
          for (const k of Object.keys(outHeaders)) {
            if (k.toLowerCase() === "content-length") delete outHeaders[k]
          }
          outHeaders["content-length"] = String(outBody.length)
        }
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
// Persistent intercept queue
// ---------------------------------------------------------------------------

interface PendingRow {
  id: number
  ts: number
  proxy_pid: number
  phase: string
  method: string
  scheme: string
  host: string
  port: number
  path: string
  headers: string
  body: Buffer | null
  status: string
  action: string | null
  action_payload: string | null
  resolved_at: number | null
}

function enqueueIntercept(args: {
  phase: "request" | "response"
  method: string
  scheme: string
  host: string
  port: number
  path: string
  headers: Record<string, string>
  body: Buffer
}): number {
  const result = db.run(
    `INSERT INTO pending_intercepts
     (ts, proxy_pid, phase, method, scheme, host, port, path, headers, body, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      Date.now(),
      process.pid,
      args.phase,
      args.method,
      args.scheme,
      args.host,
      args.port,
      args.path,
      JSON.stringify(args.headers),
      args.body,
    ],
  )
  return Number(result.lastInsertRowid)
}

function waitForInterceptAction(id: number, timeoutMs: number): Promise<InterceptAction> {
  return new Promise<InterceptAction>((resolve) => {
    const startedAt = Date.now()
    const tick = () => {
      const row = db.query("SELECT status, action, action_payload FROM pending_intercepts WHERE id = ?").get(id) as
        | { status: string; action: string | null; action_payload: string | null }
        | undefined
      if (!row) return resolve({ kind: "forward" })
      if (row.status !== "pending") {
        if (row.action === "drop") return resolve({ kind: "drop" })
        if (row.action === "edit" && row.action_payload) {
          try {
            const p = JSON.parse(row.action_payload) as {
              method?: string
              url?: string
              headers?: Record<string, string>
              body?: string
            }
            return resolve({
              kind: "edit",
              method: p.method,
              url: p.url,
              headers: p.headers,
              body: p.body !== undefined ? Buffer.from(p.body, "utf8") : undefined,
            })
          } catch {
            return resolve({ kind: "forward" })
          }
        }
        return resolve({ kind: "forward" })
      }
      if (Date.now() - startedAt > timeoutMs) {
        info(`[intercept] #${id} auto-forwarded after ${timeoutMs}ms timeout`)
        db.run(
          "UPDATE pending_intercepts SET status='auto-forwarded', action='forward', resolved_at=? WHERE id=?",
          [Date.now(), id],
        )
        return resolve({ kind: "forward" })
      }
      setTimeout(tick, 120) // 120ms poll cadence
    }
    tick()
  })
}

function cmdInterceptAction() {
  const id = Number(cli.args[1])
  const action = cli.args[2] // forward | drop | edit
  if (!Number.isFinite(id) || !["forward", "drop", "edit"].includes(action)) {
    bail("usage: intercept-action <id> <forward|drop|edit> [--method M --url U --header H:V --body B]")
  }
  const row = db.query("SELECT * FROM pending_intercepts WHERE id = ?").get(id) as PendingRow | undefined
  if (!row) bail(`no pending intercept with id ${id}`)
  if (row.status !== "pending") bail(`intercept ${id} already resolved (status=${row.status})`)

  let payload: string | null = null
  if (action === "edit") {
    const p: Record<string, unknown> = {}
    if (cli.flag("method")) p.method = cli.flag("method")!.toUpperCase()
    if (cli.flag("url")) p.url = cli.flag("url")
    const hs = cli.headers()
    if (Object.keys(hs).length) p.headers = hs
    if (cli.flag("body") !== null) p.body = cli.flag("body")
    payload = JSON.stringify(p)
  }
  db.run(
    "UPDATE pending_intercepts SET status='resolved', action=?, action_payload=?, resolved_at=? WHERE id=?",
    [action, payload, Date.now(), id],
  )
  ok(`intercept ${id} → ${action}${payload ? " " + payload : ""}`)
}

function cmdPending() {
  const json = cli.has("--json")
  const rows = db
    .query(
      "SELECT id, ts, phase, method, scheme, host, path, status FROM pending_intercepts WHERE status='pending' ORDER BY id ASC",
    )
    .all() as Array<{
    id: number
    ts: number
    phase: string
    method: string
    scheme: string
    host: string
    path: string
    status: string
  }>
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log("(no pending intercepts)")
    return
  }
  console.log(`# Pending intercepts — ${rows.length}\n`)
  for (const r of rows) {
    console.log(
      `#${String(r.id).padEnd(5)} ${new Date(r.ts).toISOString()}  ${r.method.padEnd(6)} ${r.scheme}://${r.host}${r.path}`,
    )
  }
  console.log(`\nResolve with: bun http-proxy.ts intercept-action <id> <forward|drop|edit> [...]`)
}

// ---------------------------------------------------------------------------
// Control HTTP API (for the UI / agent)
// ---------------------------------------------------------------------------

interface ControlServerOpts {
  port: number
  bind: string
}

function startControlApi(opts: ControlServerOpts) {
  const { createServer } = require("node:http") as typeof import("node:http")
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    res.setHeader("content-type", "application/json")
    res.setHeader("access-control-allow-origin", "*")
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS")
    res.setHeader("access-control-allow-headers", "content-type")
    if (req.method === "OPTIONS") {
      res.statusCode = 204
      res.end()
      return
    }

    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.end(JSON.stringify(body))
    }

    const readJson = async (): Promise<unknown> => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const txt = Buffer.concat(chunks).toString("utf8")
      if (!txt) return {}
      try {
        return JSON.parse(txt)
      } catch {
        return {}
      }
    }

    ;(async () => {
      try {
        // GET /flows?limit=&host=&status=&grep=
        if (req.method === "GET" && path === "/flows") {
          const limit = Number(url.searchParams.get("limit") ?? 50)
          const host = url.searchParams.get("host")
          const status = url.searchParams.get("status")
          const grep = url.searchParams.get("grep")
          let sql =
            "SELECT id, ts, method, scheme, host, port, path, status, resp_body_size, resp_content_type, duration_ms, error, flagged FROM flows"
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
          const rows = db.query(sql).all(...(params as never[]))
          return send(200, rows)
        }

        // GET /flows/:id
        const flowMatch = /^\/flows\/(\d+)$/.exec(path)
        if (req.method === "GET" && flowMatch) {
          const id = Number(flowMatch[1])
          const row = db.query("SELECT * FROM flows WHERE id = ?").get(id) as FlowRow | undefined
          if (!row) return send(404, { error: `no flow ${id}` })
          return send(200, {
            ...row,
            req_headers: JSON.parse(row.req_headers),
            resp_headers: row.resp_headers ? JSON.parse(row.resp_headers) : {},
            req_body: row.req_body ? row.req_body.toString("utf8") : "",
            resp_body: row.resp_body ? row.resp_body.toString("utf8") : "",
          })
        }

        // POST /flows/:id/flag
        const flagMatch = /^\/flows\/(\d+)\/flag$/.exec(path)
        if (req.method === "POST" && flagMatch) {
          const id = Number(flagMatch[1])
          db.run("UPDATE flows SET flagged = 1 - flagged WHERE id = ?", [id])
          return send(200, { ok: true, id })
        }

        // GET /pending
        if (req.method === "GET" && path === "/pending") {
          const rows = db
            .query(
              "SELECT id, ts, phase, method, scheme, host, port, path, headers, body, status FROM pending_intercepts WHERE status='pending' ORDER BY id ASC",
            )
            .all() as PendingRow[]
          return send(
            200,
            rows.map((r) => ({
              ...r,
              headers: JSON.parse(r.headers),
              body: r.body ? r.body.toString("utf8") : "",
            })),
          )
        }

        // POST /pending/:id/forward | drop | edit
        const pendingMatch = /^\/pending\/(\d+)\/(forward|drop|edit)$/.exec(path)
        if (req.method === "POST" && pendingMatch) {
          const id = Number(pendingMatch[1])
          const action = pendingMatch[2]
          const row = db.query("SELECT status FROM pending_intercepts WHERE id = ?").get(id) as
            | { status: string }
            | undefined
          if (!row) return send(404, { error: "no pending" })
          if (row.status !== "pending") return send(409, { error: `already ${row.status}` })
          let payload: string | null = null
          if (action === "edit") {
            const body = (await readJson()) as Record<string, unknown>
            payload = JSON.stringify(body)
          }
          db.run(
            "UPDATE pending_intercepts SET status='resolved', action=?, action_payload=?, resolved_at=? WHERE id=?",
            [action, payload, Date.now(), id],
          )
          return send(200, { ok: true, id, action })
        }

        // GET /rules / POST /rules / DELETE /rules/:id / POST /rules/:id/toggle
        if (req.method === "GET" && path === "/rules") {
          return send(200, listRules())
        }
        if (req.method === "POST" && path === "/rules") {
          const body = (await readJson()) as { type: string; scope: string; match: string; replace: string; description?: string; enabled?: boolean }
          if (!body.type || !body.scope || !body.match) return send(400, { error: "type/scope/match required" })
          if (!["request", "response"].includes(body.type)) return send(400, { error: "type must be request|response" })
          if (!["header", "body", "url"].includes(body.scope)) return send(400, { error: "scope must be header|body|url" })
          const result = db.run(
            "INSERT INTO rules (enabled, type, scope, match, replace, description) VALUES (?, ?, ?, ?, ?, ?)",
            [body.enabled === false ? 0 : 1, body.type, body.scope, body.match, body.replace ?? "", body.description ?? null],
          )
          return send(200, { ok: true, id: Number(result.lastInsertRowid) })
        }
        const ruleDelMatch = /^\/rules\/(\d+)$/.exec(path)
        if (req.method === "DELETE" && ruleDelMatch) {
          db.run("DELETE FROM rules WHERE id = ?", [Number(ruleDelMatch[1])])
          return send(200, { ok: true })
        }
        const ruleToggleMatch = /^\/rules\/(\d+)\/toggle$/.exec(path)
        if (req.method === "POST" && ruleToggleMatch) {
          db.run("UPDATE rules SET enabled = 1 - enabled WHERE id = ?", [Number(ruleToggleMatch[1])])
          return send(200, { ok: true })
        }

        // GET /settings
        if (req.method === "GET" && path === "/settings") {
          const intercept = readSetting("intercept") === "1"
          const port = readSetting("port") ?? "8181"
          const flowCount = (db.query("SELECT COUNT(*) AS c FROM flows").get() as { c: number }).c
          const pendingCount = (db.query("SELECT COUNT(*) AS c FROM pending_intercepts WHERE status='pending'").get() as { c: number }).c
          return send(200, { intercept, port: Number(port), flowCount, pendingCount })
        }

        // POST /settings/intercept  body { on: bool }
        if (req.method === "POST" && path === "/settings/intercept") {
          const body = (await readJson()) as { on?: boolean }
          writeSetting("intercept", body.on ? "1" : "0")
          return send(200, { ok: true, intercept: !!body.on })
        }

        // GET /events  → SSE stream of flow + pending changes
        if (req.method === "GET" && path === "/events") {
          res.setHeader("content-type", "text/event-stream")
          res.setHeader("cache-control", "no-cache")
          res.setHeader("connection", "keep-alive")
          res.statusCode = 200
          res.write("retry: 2000\n\n")
          let lastFlow = (db.query("SELECT MAX(id) AS m FROM flows").get() as { m: number | null }).m ?? 0
          let lastPending = (db.query("SELECT MAX(id) AS m FROM pending_intercepts").get() as { m: number | null }).m ?? 0
          const tick = setInterval(() => {
            try {
              const newFlows = db
                .query("SELECT id, method, scheme, host, path, status, resp_body_size, duration_ms, ts FROM flows WHERE id > ? ORDER BY id ASC LIMIT 50")
                .all(lastFlow) as Array<{ id: number }>
              for (const f of newFlows) {
                res.write(`event: flow\ndata: ${JSON.stringify(f)}\n\n`)
                lastFlow = Math.max(lastFlow, f.id)
              }
              const newPending = db
                .query(
                  "SELECT id, method, scheme, host, path, status, ts FROM pending_intercepts WHERE id > ? ORDER BY id ASC",
                )
                .all(lastPending) as Array<{ id: number; status: string }>
              for (const p of newPending) {
                res.write(`event: pending\ndata: ${JSON.stringify(p)}\n\n`)
                lastPending = Math.max(lastPending, p.id)
              }
              // Resolved pending
              const resolved = db
                .query(
                  "SELECT id, status, action FROM pending_intercepts WHERE resolved_at > ? ORDER BY resolved_at ASC LIMIT 50",
                )
                .all(Date.now() - 5000) as Array<{ id: number }>
              for (const r of resolved) res.write(`event: resolved\ndata: ${JSON.stringify(r)}\n\n`)
              res.write(`: ping\n\n`)
            } catch {
              /* ignore */
            }
          }, 800)
          req.on("close", () => clearInterval(tick))
          return
        }

        // GET /stats
        if (req.method === "GET" && path === "/stats") {
          const total = (db.query("SELECT COUNT(*) AS c FROM flows").get() as { c: number }).c
          const byHost = db
            .query("SELECT host, COUNT(*) AS n FROM flows GROUP BY host ORDER BY n DESC LIMIT 10")
            .all()
          const byStatus = db.query("SELECT status, COUNT(*) AS n FROM flows GROUP BY status ORDER BY n DESC").all()
          return send(200, { total, byHost, byStatus })
        }

        // GET /health
        if (path === "/health") return send(200, { ok: true, pid: process.pid })

        send(404, { error: `no route for ${req.method} ${path}` })
      } catch (e) {
        send(500, { error: (e as Error).message })
      }
    })()
  })
  server.listen(opts.port, opts.bind, () => {
    info(`✓ control API listening on http://${opts.bind}:${opts.port}`)
    info(`  endpoints: /flows /flows/:id /pending /rules /settings /events /stats`)
  })
  return server
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
    --api-port N              also expose REST control API on this port
    --api-bind ADDR           default 127.0.0.1

  ca-export <path>            write the local Root CA pem
  list [--limit N --host H --status S --grep TEXT --json]
                              browse captured flows
  show <id> [--json]          show one full flow (decoded headers + body)
  send-to-repeater <id>       emit JSON the repeater can consume
  intercept <on|off>          flip interception on a running proxy
  pending [--json]            list pending intercepts awaiting decision
  intercept-action <id> <forward|drop|edit> [--method M --url U --header H:V --body B]
                              resolve a pending intercept
  match-and-replace list
  match-and-replace add --type request|response --scope header|body|url \\
                          --match REGEX --replace TEXT [--description ""]
  match-and-replace remove <id>
  match-and-replace toggle <id>
  clear --yes                 wipe history DB
  stats [--json]              top hosts / status / slow flows

Control API endpoints (when --api-port set):
  GET  /flows ?limit&host&status&grep
  GET  /flows/:id
  POST /flows/:id/flag
  GET  /pending
  POST /pending/:id/{forward|drop|edit}
  GET  /rules
  POST /rules
  DELETE /rules/:id
  POST /rules/:id/toggle
  GET  /settings
  POST /settings/intercept   { on: true|false }
  GET  /events                (SSE stream)
  GET  /stats
  GET  /health

Storage: ${DATA_DIR}
`)
  process.exit(code)
}
