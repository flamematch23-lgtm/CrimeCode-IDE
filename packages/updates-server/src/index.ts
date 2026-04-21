import { file } from "bun"
import { join, normalize } from "node:path"

const port = Number(process.env.PORT ?? 8080)
const root = join(import.meta.dir, "..", "public")

const types: Record<string, string> = {
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

type Stat = { count: number; bytes: number; lastAt: number }
const stats = new Map<string, Stat>()

function bump(name: string, bytes: number) {
  const s = stats.get(name) ?? { count: 0, bytes: 0, lastAt: 0 }
  s.count += 1
  s.bytes += bytes
  s.lastAt = Date.now()
  stats.set(name, s)
}

async function readVersion() {
  const yml = file(join(root, "latest.yml"))
  if (!(await yml.exists())) return null
  const txt = await yml.text()
  const get = (k: string) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(txt)
    return m?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null
  }
  const version = get("version")
  const releaseDate = get("releaseDate")
  const path = get("path")
  let sha512: string | null = null
  let size: number | null = null
  const fileBlock = /files:\s*\n([\s\S]+?)(?:\npath:|\n\w+:)/m.exec(txt)
  if (fileBlock) {
    const sm = /sha512:\s*(.+)/.exec(fileBlock[1]!)
    if (sm) sha512 = sm[1]!.trim().replace(/^['"]|['"]$/g, "")
    const zm = /size:\s*(\d+)/.exec(fileBlock[1]!)
    if (zm) size = Number(zm[1])
  }
  return { version, releaseDate, path, sha512, size }
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtAgo(ms: number) {
  const d = Date.now() - ms
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}

async function adminPage() {
  const v = await readVersion()
  const rows = [...stats.entries()]
    .sort((a, b) => b[1].lastAt - a[1].lastAt)
    .map(
      ([name, s]) =>
        `<tr><td>${name}</td><td>${s.count}</td><td>${fmtBytes(s.bytes)}</td><td>${fmtAgo(s.lastAt)}</td></tr>`,
    )
    .join("")
  return `<!doctype html><html><head><meta charset="utf-8"><title>updates-server admin</title>
<style>body{font:14px system-ui;margin:24px;background:#0a0a0a;color:#e5e5e5}h1{font-size:18px}h2{font-size:14px;margin-top:24px;color:#888}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{text-align:left;padding:6px 12px;border-bottom:1px solid #222}
th{color:#888;font-weight:500;font-size:12px;text-transform:uppercase}code{background:#1a1a1a;padding:2px 6px;border-radius:3px}
.ok{color:#4ade80}.warn{color:#fbbf24}</style></head><body>
<h1>updates-server</h1>
<h2>Current release</h2>
${
  v
    ? `<table><tr><td>version</td><td><code>${v.version ?? "?"}</code></td></tr>
<tr><td>file</td><td><code>${v.path ?? "?"}</code></td></tr>
<tr><td>size</td><td>${v.size ? fmtBytes(v.size) : "?"}</td></tr>
<tr><td>sha512</td><td><code style="font-size:11px">${(v.sha512 ?? "?").slice(0, 64)}…</code></td></tr>
<tr><td>releaseDate</td><td>${v.releaseDate ?? "?"}</td></tr></table>`
    : `<p class="warn">latest.yml not found</p>`
}
<h2>Download stats (in-memory, since boot)</h2>
${rows ? `<table><tr><th>file</th><th>requests</th><th>bytes</th><th>last</th></tr>${rows}</table>` : `<p>no requests yet</p>`}
<h2>Endpoints</h2>
<ul><li><code>GET /health</code> — liveness</li><li><code>GET /version</code> — JSON version info</li>
<li><code>GET /latest.yml</code> — electron-updater manifest</li><li><code>GET /admin</code> — this page</li></ul>
</body></html>`
}

function parseRange(header: string, size: number) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  if (m[1] === "") {
    if (m[2] === "") return null
    let suffix = Number(m[2])
    if (suffix === 0) return null
    if (suffix > size) suffix = size
    return { start: size - suffix, end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return null
  let end = m[2] === "" ? size - 1 : Number(m[2])
  if (end >= size) end = size - 1
  if (start > end) return null
  return { start, end }
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const logPrefix = `[${req.method}] ${url.pathname} | Range: ${req.headers.get("range") || "none"}`
    if (url.pathname === "/" || url.pathname === "/health") {
      console.log(`${logPrefix} -> 200 ok`)
      return new Response("ok", { headers: { "content-type": "text/plain" } })
    }
    if (url.pathname === "/version") {
      const v = await readVersion()
      if (!v)
        return new Response(JSON.stringify({ error: "no release" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      return new Response(JSON.stringify(v, null, 2), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-cache, no-store, must-revalidate",
          "access-control-allow-origin": "*",
        },
      })
    }
    if (url.pathname === "/admin") {
      return new Response(await adminPage(), { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    if (url.pathname === "/admin/stats.json") {
      const obj = Object.fromEntries(stats)
      return new Response(JSON.stringify(obj, null, 2), { headers: { "content-type": "application/json" } })
    }
    const safe = normalize(url.pathname).replace(/^([/\\])+/, "")
    if (safe.includes("..")) {
      console.log(`${logPrefix} -> 403 forbidden`)
      return new Response("forbidden", { status: 403 })
    }
    const path = join(root, safe)
    const f = file(path)
    if (!(await f.exists())) {
      console.log(`${logPrefix} -> 404 not found`)
      return new Response("not found", { status: 404 })
    }
    const ext = safe.slice(safe.lastIndexOf("."))
    const type = types[ext] ?? "application/octet-stream"
    const size = f.size

    const isMetadata = ext === ".yml" || ext === ".yaml" || ext === ".json"
    const cacheControl = isMetadata ? "no-cache, no-store, must-revalidate" : "public, max-age=300"

    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
      "accept-ranges": "bytes",
    }
    const rh = req.headers.get("range")
    if (rh) {
      const r = parseRange(rh, size)
      if (!r) {
        console.log(`${logPrefix} -> 416 range not satisfiable`)
        return new Response("range not satisfiable", {
          status: 416,
          headers: { ...headers, "content-range": `bytes */${size}` },
        })
      }
      headers["content-range"] = `bytes ${r.start}-${r.end}/${size}`
      const len = r.end - r.start + 1
      headers["content-length"] = String(len)
      bump(safe, len)
      console.log(`${logPrefix} -> 206 Partial Content (${r.start}-${r.end})`)
      return new Response(f.slice(r.start, r.end + 1), { status: 206, headers })
    }
    headers["content-length"] = String(size)
    bump(safe, size)
    console.log(`${logPrefix} -> 200 OK (${size} bytes)`)
    return new Response(f, { headers })
  },
})

console.log(`updates-server listening on :${port}, root=${root}`)
