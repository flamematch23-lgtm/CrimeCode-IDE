#!/usr/bin/env bun
/**
 * collaborator.ts — Burp Collaborator equivalent.
 *
 * Out-of-band (OOB) interaction capture server. The agent generates a
 * unique payload (subdomain or HTTP path), embeds it in an attack
 * (SSRF, XXE, SSTI, command-injection, log4shell-style JNDI, blind XSS,
 * etc.), and any back-channel HTTP/DNS request to that payload is
 * captured here for later inspection.
 *
 * Modes:
 *   start                       run the listener (foreground)
 *   payload [--type http|dns]   mint a fresh callback identifier + URL
 *   list   [--id ID --json]     show captured interactions
 *   show   <id>                 dump one interaction (full headers + body)
 *   poll   <token>              return any interactions for a payload (JSON)
 *   clear  --yes                wipe interactions DB
 *   stats  [--json]             aggregated counters
 *
 * The callback URL is `http://<host>:<port>/<token>` and (if DNS mode is
 * configured with --bind-dns) `<token>.<dns-zone>` for DNS exfiltration.
 *
 * Implementation:
 *   - Tiny HTTP server on a configurable port (default 8281) that records
 *     every request keyed on the URL path's first segment (the token).
 *   - Optional UDP DNS server (default port 8253) that records every
 *     query for which the QNAME starts with a known token. We don't
 *     actually answer (NXDOMAIN) — capturing the lookup is enough.
 *   - SQLite persistence at $XDG_DATA_HOME/crimecode/collaborator/db.sqlite
 *
 * Safety:
 *   The server doesn't listen on 0.0.0.0 by default. To use it as a
 *   real callback target you'll need to expose <host>:<port> on the
 *   public internet (--bind 0.0.0.0 + a forwarding rule on your router
 *   / VPS). Don't do that on a sensitive machine.
 */
import { argv } from "node:process"
import { createServer as createHttpServer } from "node:http"
import { createSocket } from "node:dgram"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"
import { makeArgs, bail, ok, info } from "./_lib/common.ts"

// ---------------------------------------------------------------------------
// Paths / DB
// ---------------------------------------------------------------------------

const DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "crimecode",
  "collaborator",
)
mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = join(DATA_DIR, "db.sqlite")

const db = new Database(DB_PATH)
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS payloads (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- 'http' | 'dns' | 'both'
  created_at INTEGER NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  protocol TEXT NOT NULL,         -- 'http' | 'dns'
  client_ip TEXT,
  method TEXT,
  url TEXT,
  headers TEXT,
  body BLOB,
  qname TEXT,
  qtype TEXT
);
CREATE INDEX IF NOT EXISTS idx_interactions_token ON interactions(token);
CREATE INDEX IF NOT EXISTS idx_interactions_ts ON interactions(ts);
`)

// DNS QTYPE lookup table — declared up here (before any function that
// references it) so the TDZ audit stays happy even though the parser is
// only invoked from a runtime callback.
const DNS_TYPES: Record<number, string> = {
  1: "A",
  2: "NS",
  5: "CNAME",
  6: "SOA",
  12: "PTR",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  41: "OPT",
  255: "ANY",
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cli = makeArgs(argv)
const cmd = cli.args[0]
if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

if (cmd === "start") await cmdStart()
else if (cmd === "payload") cmdPayload()
else if (cmd === "list") cmdList()
else if (cmd === "show") cmdShow()
else if (cmd === "poll") cmdPoll()
else if (cmd === "clear") cmdClear()
else if (cmd === "stats") cmdStats()
else usage(2)

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function cmdStart() {
  const port = cli.num("port", 8281)
  const bind = cli.flag("bind") ?? "127.0.0.1"
  const dnsZone = cli.flag("dns-zone") ?? null
  const dnsPort = cli.num("dns-port", 8253)
  const dnsBind = cli.flag("bind-dns") ?? null

  // HTTP listener
  const http = createHttpServer((req, res) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")
    const url = req.url ?? "/"
    const token = (url.split("/")[1] ?? "").split("?")[0].split(".")[0]

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers[k] = v.join(", ")
      else if (v !== undefined) headers[k] = String(v)
    }
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      if (token && tokenExists(token)) {
        db.run(
          `INSERT INTO interactions (token, ts, protocol, client_ip, method, url, headers, body)
           VALUES (?, ?, 'http', ?, ?, ?, ?, ?)`,
          [token, Date.now(), ip, req.method ?? "GET", url, JSON.stringify(headers), body],
        )
        info(`[oob/http] ${ip}  ${req.method} ${url}  token=${token}`)
      } else {
        info(`[oob/http] ${ip}  ${req.method} ${url}  (no matching token)`)
      }
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ack\n")
    })
  })
  http.listen(port, bind, () =>
    info(
      `✓ collaborator HTTP listening on http://${bind}:${port}\n` +
        `  payload URL prefix: http://<your-host>:${port}/<token>\n` +
        `  storage: ${DB_PATH}`,
    ),
  )

  // Optional DNS listener
  if (dnsBind && dnsZone) {
    const sock = createSocket("udp4")
    sock.on("message", (msg, rinfo) => {
      const parsed = parseDnsQuery(msg)
      if (!parsed) return
      const qname = parsed.qname.toLowerCase()
      const qtype = parsed.qtype
      // Capture if QNAME is something like <token>.<zone>
      const zone = dnsZone.toLowerCase().replace(/^\./, "")
      const idx = qname.indexOf("." + zone)
      const tokenLabel = idx > 0 ? qname.slice(0, idx) : qname
      const tok = tokenLabel.split(".").pop() ?? tokenLabel
      if (tok && tokenExists(tok)) {
        db.run(
          `INSERT INTO interactions (token, ts, protocol, client_ip, qname, qtype)
           VALUES (?, ?, 'dns', ?, ?, ?)`,
          [tok, Date.now(), rinfo.address, qname, qtype],
        )
        info(`[oob/dns ] ${rinfo.address}  ${qname} (${qtype})  token=${tok}`)
      }
      // We respond NXDOMAIN so the resolver doesn't hammer us.
      const reply = buildNxDomain(msg)
      sock.send(reply, rinfo.port, rinfo.address)
    })
    sock.bind(dnsPort, dnsBind, () =>
      info(
        `✓ collaborator DNS listening on ${dnsBind}:${dnsPort}\n` +
          `  payload zone: <token>.${dnsZone}`,
      ),
    )
  }

  process.on("SIGINT", () => {
    info("\n✓ collaborator stopping…")
    http.close()
    process.exit(0)
  })
}

// ---------------------------------------------------------------------------
// Payload mint
// ---------------------------------------------------------------------------

function cmdPayload() {
  const type = (cli.flag("type") ?? "http") as "http" | "dns" | "both"
  const note = cli.flag("note") ?? null
  const host = cli.flag("host") ?? "127.0.0.1"
  const port = cli.num("port", 8281)
  const dnsZone = cli.flag("dns-zone") ?? null

  // 16-char alphanumeric, lowercase
  const token = randomBytes(12)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16)
    .padEnd(16, "x")

  db.run(`INSERT INTO payloads (token, type, created_at, note) VALUES (?, ?, ?, ?)`, [
    token,
    type,
    Date.now(),
    note,
  ])

  const httpUrl = `http://${host}:${port}/${token}`
  const dnsUrl = dnsZone ? `${token}.${dnsZone}` : null
  if (cli.has("--json")) {
    console.log(JSON.stringify({ token, http: httpUrl, dns: dnsUrl, type }, null, 2))
    return
  }
  ok(`minted token ${token}`)
  console.log(`  HTTP callback: ${httpUrl}`)
  if (dnsUrl) console.log(`  DNS  callback: ${dnsUrl}`)
  console.log(`  poll:          bun collaborator.ts poll ${token}`)
}

function tokenExists(token: string): boolean {
  const r = db.query("SELECT 1 FROM payloads WHERE token = ?").get(token) as unknown
  return !!r
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function cmdList() {
  const token = cli.flag("id") ?? cli.flag("token")
  const limit = cli.num("limit", 50)
  const json = cli.has("--json")
  let sql = "SELECT id, token, ts, protocol, client_ip, method, url, qname, qtype FROM interactions"
  const params: unknown[] = []
  if (token) {
    sql += " WHERE token = ?"
    params.push(token)
  }
  sql += " ORDER BY id DESC LIMIT ?"
  params.push(limit)
  const rows = db.query(sql).all(...(params as never[])) as Array<{
    id: number
    token: string
    ts: number
    protocol: string
    client_ip: string | null
    method: string | null
    url: string | null
    qname: string | null
    qtype: string | null
  }>
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log("(no interactions)")
    return
  }
  console.log(`# Collaborator interactions — ${rows.length}\n`)
  for (const r of rows) {
    const when = new Date(r.ts).toISOString()
    if (r.protocol === "http") {
      console.log(`#${r.id}  ${when}  ${r.client_ip}  HTTP  ${r.method} ${r.url}  token=${r.token}`)
    } else {
      console.log(`#${r.id}  ${when}  ${r.client_ip}  DNS   ${r.qname} (${r.qtype})  token=${r.token}`)
    }
  }
}

function cmdShow() {
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: show <id>")
  const r = db.query("SELECT * FROM interactions WHERE id = ?").get(id) as
    | {
        id: number
        token: string
        ts: number
        protocol: string
        client_ip: string | null
        method: string | null
        url: string | null
        headers: string | null
        body: Buffer | null
        qname: string | null
        qtype: string | null
      }
    | undefined
  if (!r) bail(`no interaction #${id}`)
  if (cli.has("--json")) {
    console.log(
      JSON.stringify(
        {
          ...r,
          headers: r.headers ? JSON.parse(r.headers) : null,
          body: r.body ? r.body.toString("utf8") : null,
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(`# Interaction #${r.id}  ${new Date(r.ts).toISOString()}`)
  console.log(`token: ${r.token}   protocol: ${r.protocol}   client: ${r.client_ip}`)
  if (r.protocol === "http") {
    console.log(`\n${r.method} ${r.url}`)
    const h = r.headers ? (JSON.parse(r.headers) as Record<string, string>) : {}
    for (const [k, v] of Object.entries(h)) console.log(`${k}: ${v}`)
    if (r.body && r.body.length > 0) console.log(`\n${r.body.toString("utf8")}`)
  } else {
    console.log(`\nQNAME: ${r.qname}`)
    console.log(`QTYPE: ${r.qtype}`)
  }
}

function cmdPoll() {
  const token = cli.args[1]
  if (!token) bail("usage: poll <token>")
  const since = cli.num("since", 0)
  const rows = db
    .query(
      "SELECT id, ts, protocol, client_ip, method, url, qname, qtype FROM interactions WHERE token = ? AND ts > ? ORDER BY id ASC",
    )
    .all(token, since) as Array<unknown>
  console.log(JSON.stringify({ token, count: rows.length, interactions: rows }, null, 2))
}

function cmdClear() {
  if (!cli.has("--yes")) bail("clear requires --yes (drops all interactions)")
  const tok = cli.flag("token")
  if (tok) {
    db.run("DELETE FROM interactions WHERE token = ?", [tok])
    ok(`cleared interactions for ${tok}`)
  } else {
    db.run("DELETE FROM interactions")
    db.run("DELETE FROM payloads")
    ok("cleared all interactions and payloads")
  }
}

function cmdStats() {
  const total = (db.query("SELECT COUNT(*) AS c FROM interactions").get() as { c: number }).c
  const tokens = (db.query("SELECT COUNT(*) AS c FROM payloads").get() as { c: number }).c
  const byProto = db.query("SELECT protocol, COUNT(*) AS n FROM interactions GROUP BY protocol").all() as Array<{
    protocol: string
    n: number
  }>
  const top = db
    .query(
      "SELECT token, COUNT(*) AS n FROM interactions GROUP BY token ORDER BY n DESC LIMIT 10",
    )
    .all() as Array<{ token: string; n: number }>
  if (cli.has("--json")) {
    console.log(JSON.stringify({ tokens, interactions: total, byProto, top }, null, 2))
    return
  }
  console.log(`# Collaborator stats`)
  console.log(`  payloads:     ${tokens}`)
  console.log(`  interactions: ${total}`)
  console.log(`  by protocol:`)
  for (const p of byProto) console.log(`    ${p.protocol.padEnd(5)} ${p.n}`)
  console.log(`  top tokens:`)
  for (const t of top) console.log(`    ${t.n.toString().padStart(5)}  ${t.token}`)
}

// ---------------------------------------------------------------------------
// DNS helpers (minimal)
// ---------------------------------------------------------------------------

function parseDnsQuery(buf: Buffer): { qname: string; qtype: string } | null {
  if (buf.length < 12) return null
  let p = 12
  const labels: string[] = []
  while (p < buf.length) {
    const len = buf[p]
    if (len === 0) {
      p++
      break
    }
    if ((len & 0xc0) === 0xc0) return null // pointer in question — unusual
    p++
    if (p + len > buf.length) return null
    labels.push(buf.toString("ascii", p, p + len))
    p += len
  }
  if (p + 4 > buf.length) return null
  const qtype = buf.readUInt16BE(p)
  const qtypeStr = DNS_TYPES[qtype] ?? String(qtype)
  return { qname: labels.join("."), qtype: qtypeStr }
}

function buildNxDomain(query: Buffer): Buffer {
  const reply = Buffer.from(query)
  // Set QR=1, RCODE=3 (NXDOMAIN). Flags are at offset 2 (2 bytes).
  reply[2] = 0x81 // QR=1, OPCODE=0, AA=0, TC=0, RD=1
  reply[3] = 0x83 // RA=1, Z=0, RCODE=3 (NXDOMAIN)
  // ANCOUNT, NSCOUNT, ARCOUNT = 0
  reply.writeUInt16BE(0, 6)
  reply.writeUInt16BE(0, 8)
  reply.writeUInt16BE(0, 10)
  return reply
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`collaborator.ts <command> [flags]

Burp Collaborator–style out-of-band callback capture.

Commands:
  start                          run HTTP (+ optional DNS) listener
    --port N                     HTTP port (default 8281)
    --bind ADDR                  HTTP bind (default 127.0.0.1)
    --bind-dns ADDR              enable DNS capture
    --dns-port N                 DNS port (default 8253)
    --dns-zone DOMAIN            zone, e.g. oob.example.com

  payload [--type http|dns|both] mint a fresh callback token
    --host HOST                  for the printed URL (default 127.0.0.1)
    --port N                     for the printed URL (default 8281)
    --dns-zone DOMAIN            for the printed DNS payload
    --note "text"                attach a note to the payload
    --json

  list   [--token TOK --limit N --json]
  show   <id> [--json]
  poll   <token> [--since MS]    fetch interactions newer than MS, JSON only
  clear  --yes [--token TOK]     wipe interactions (and payloads if no token)
  stats  [--json]

Storage: ${DATA_DIR}
`)
  process.exit(code)
}
