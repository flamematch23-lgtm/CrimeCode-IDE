#!/usr/bin/env bun
/**
 * site-crawler.ts — Burp Suite Site Map / Crawler equivalent.
 *
 * Walk a target host, build a tree of discovered URLs + parameters,
 * and write the tree (json or markdown) for the agent to triage. Plays
 * well with vuln-scanner active mode (feed it the URLs the crawler
 * found that have query parameters).
 *
 * Discovery sources:
 *   - HTML <a href> / <form action> / <link href> / <script src> / <img src>
 *   - JS: simple regex sweep for `"/path"` literals in inline scripts
 *   - sitemap.xml + sitemap_index.xml
 *   - robots.txt (uses Disallow paths as candidates, not as boundaries)
 *
 * Scope:
 *   - same-host by default (toggle with --include-subdomains)
 *   - --max-depth (default 3)
 *   - --max-pages (default 200, hard cap 5000)
 *   - --include / --exclude path globs (repeatable)
 *
 * Auth:
 *   - --header "Cookie: ..." or any other header
 *   - --basic-auth user:pass
 *
 * Output:
 *   default markdown tree with parameters per endpoint
 *   --json    structured site map (suitable for piping to scanner)
 *   --csv     flat URL list
 *
 * Usage:
 *   bun site-crawler.ts --url https://target/ --max-pages 100
 *   bun site-crawler.ts --url https://target/ --json | jq '.[].url'
 */
import { argv } from "node:process"
import { performance } from "node:perf_hooks"
import { ensureHostAllowed, makeArgs, bail, info } from "./_lib/common.ts"

const cli = makeArgs(argv)
if (cli.has("--help") || cli.has("-h")) usage(0)

const startUrl = cli.required("url")
const allowPrivate = cli.has("--allow-private")
ensureHostAllowed(startUrl, allowPrivate)

const maxDepth = cli.num("max-depth", 3)
const maxPages = Math.min(cli.num("max-pages", 200), 5000)
const rateLimit = cli.num("rate-limit", 8)
const timeoutMs = cli.num("timeout", 12_000)
const includeSubdomains = cli.has("--include-subdomains")
const headers = cli.headers()
if (cli.flag("basic-auth")) {
  const ba = cli.flag("basic-auth")!
  headers["Authorization"] = `Basic ${Buffer.from(ba).toString("base64")}`
}
const respectRobots = !cli.has("--ignore-robots")

const includes = (cli.list("include") ?? []).map(globToRegex)
const excludes = (cli.list("exclude") ?? []).map(globToRegex)

const baseUrl = new URL(startUrl)
const baseHost = baseUrl.host

interface Page {
  url: string
  status: number | null
  contentType: string
  bytes: number
  durationMs: number
  depth: number
  parent: string | null
  params: string[]
  forms: Array<{ action: string; method: string; fields: string[] }>
  links: number
  error: string | null
}

const visited = new Map<string, Page>()
const queue: Array<{ url: string; depth: number; parent: string | null }> = [{ url: startUrl, depth: 0, parent: null }]
const denied = new Set<string>()

const tickMs = Math.max(50, 1000 / rateLimit)
let lastTick = 0

await maybeReadRobots()
await maybeReadSitemap()

while (queue.length > 0 && visited.size < maxPages) {
  const { url, depth, parent } = queue.shift()!
  if (visited.has(url)) continue
  if (denied.has(url)) continue
  if (!isInScope(url)) continue
  if (depth > maxDepth) continue
  const wait = lastTick + tickMs - Date.now()
  if (wait > 0) await sleep(wait)
  lastTick = Date.now()
  const page = await crawl(url, depth, parent)
  visited.set(url, page)
  if (visited.size % 25 === 0) info(`${visited.size}/${maxPages} pages…`)
}

emit()

// ---------------------------------------------------------------------------

async function crawl(url: string, depth: number, parent: string | null): Promise<Page> {
  const t0 = performance.now()
  const page: Page = {
    url,
    status: null,
    contentType: "",
    bytes: 0,
    durationMs: 0,
    depth,
    parent,
    params: extractParams(url),
    forms: [],
    links: 0,
    error: null,
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal })
    page.status = res.status
    page.contentType = res.headers.get("content-type") ?? ""
    const ct = page.contentType.toLowerCase()
    const text = ct.includes("text") || ct.includes("html") || ct.includes("xml") || ct.includes("json")
      ? await res.text()
      : ""
    page.bytes = text.length
    page.durationMs = Math.round(performance.now() - t0)
    if (text && depth < maxDepth) {
      const found = extractLinks(text, res.url, ct)
      page.links = found.urls.size
      page.forms = found.forms
      for (const u of found.urls) {
        if (visited.has(u) || denied.has(u)) continue
        if (!isInScope(u)) continue
        queue.push({ url: u, depth: depth + 1, parent: url })
      }
    }
  } catch (e) {
    page.error = e instanceof Error ? e.message : String(e)
    page.durationMs = Math.round(performance.now() - t0)
  } finally {
    clearTimeout(timer)
  }
  return page
}

function extractParams(url: string): string[] {
  try {
    const u = new URL(url)
    return [...u.searchParams.keys()]
  } catch {
    return []
  }
}

function extractLinks(text: string, baseFromRes: string, ct: string): {
  urls: Set<string>
  forms: Array<{ action: string; method: string; fields: string[] }>
} {
  const urls = new Set<string>()
  const forms: Array<{ action: string; method: string; fields: string[] }> = []
  const baseRef = baseFromRes

  if (ct.includes("html") || ct.includes("xml")) {
    // hrefs / srcs
    const reHref = /(?:href|src|action|data-href|data-url)\s*=\s*["']([^"'#]+)/gi
    let m: RegExpExecArray | null
    while ((m = reHref.exec(text)) !== null) {
      const u = absolutize(m[1], baseRef)
      if (u) urls.add(u)
    }
    // <form> blocks
    const reForm = /<form[^>]*>[\s\S]*?<\/form>/gi
    let f: RegExpExecArray | null
    while ((f = reForm.exec(text)) !== null) {
      const block = f[0]
      const action = /action\s*=\s*["']([^"']+)/i.exec(block)?.[1] ?? baseRef
      const method = (/method\s*=\s*["']([^"']+)/i.exec(block)?.[1] ?? "GET").toUpperCase()
      const fields: string[] = []
      const reField = /<(input|select|textarea)[^>]*name\s*=\s*["']([^"']+)/gi
      let mm: RegExpExecArray | null
      while ((mm = reField.exec(block)) !== null) fields.push(mm[2])
      const a = absolutize(action, baseRef)
      forms.push({ action: a ?? action, method, fields })
      if (a) urls.add(a)
    }
  }

  // JSON / JS — sweep for "/something" literals up to 200 chars
  const reJsPath = /["'](\/[^"'\s<>]{1,200})["']/g
  let j: RegExpExecArray | null
  while ((j = reJsPath.exec(text)) !== null) {
    const u = absolutize(j[1], baseRef)
    if (u) urls.add(u)
  }
  return { urls, forms }
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString().split("#")[0]
  } catch {
    return null
  }
}

function isInScope(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:") return false
    if (!includeSubdomains && u.host !== baseHost) return false
    if (includeSubdomains && !u.host.endsWith(baseHost.replace(/^www\./, ""))) return false
    if (excludes.some((re) => re.test(u.pathname))) return false
    if (includes.length > 0 && !includes.some((re) => re.test(u.pathname))) return false
    return true
  } catch {
    return false
  }
}

async function maybeReadRobots() {
  if (!respectRobots) return
  try {
    const res = await fetch(new URL("/robots.txt", baseUrl).toString(), { headers })
    if (!res.ok) return
    const text = await res.text()
    for (const line of text.split("\n")) {
      const m = /^\s*(allow|disallow|sitemap)\s*:\s*(.+)$/i.exec(line)
      if (!m) continue
      const v = m[2].trim()
      if (m[1].toLowerCase() === "sitemap") {
        try {
          await ingestSitemap(v)
        } catch {
          /* ignore */
        }
      } else {
        const u = absolutize(v, baseUrl.toString())
        if (u) queue.push({ url: u, depth: 1, parent: "robots.txt" })
      }
    }
  } catch {
    /* no robots */
  }
}

async function maybeReadSitemap() {
  for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
    try {
      await ingestSitemap(new URL(path, baseUrl).toString())
    } catch {
      /* ignore */
    }
  }
}

async function ingestSitemap(url: string) {
  const res = await fetch(url, { headers })
  if (!res.ok) return
  const text = await res.text()
  const urls = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
  for (const u of urls) {
    if (u.endsWith(".xml")) {
      await ingestSitemap(u)
    } else if (isInScope(u)) {
      queue.push({ url: u, depth: 1, parent: "sitemap" })
    }
  }
}

function globToRegex(glob: string): RegExp {
  // very loose: ** → .*, * → [^/]*, ? → .
  let s = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      s += ".*"
      i++
    } else if (c === "*") s += "[^/]*"
    else if (c === "?") s += "."
    else if (/[.+^${}()|[\]\\]/.test(c)) s += "\\" + c
    else s += c
  }
  return new RegExp(`^${s}$`)
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function emit() {
  const pages = [...visited.values()].sort((a, b) => a.url.localeCompare(b.url))
  if (cli.has("--json")) {
    console.log(JSON.stringify(pages, null, 2))
    return
  }
  if (cli.has("--csv")) {
    console.log("url,status,content_type,bytes,duration_ms,depth,params,forms")
    for (const p of pages) {
      const cells = [
        p.url,
        p.status ?? "",
        p.contentType,
        p.bytes,
        p.durationMs,
        p.depth,
        p.params.join("|"),
        p.forms.map((f) => `${f.method} ${f.action} (${f.fields.join("/")})`).join(";"),
      ]
      console.log(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    }
    return
  }
  // Markdown tree
  const tree = buildTree(pages)
  console.log(`# Site map — ${baseHost} (${pages.length} pages)\n`)
  printTree(tree, 0)
  console.log()
  // Stats
  const codes = new Map<number, number>()
  let withParams = 0
  let withForms = 0
  for (const p of pages) {
    if (p.status != null) codes.set(p.status, (codes.get(p.status) ?? 0) + 1)
    if (p.params.length) withParams++
    if (p.forms.length) withForms++
  }
  console.log(`Status: ${[...codes].map(([s, n]) => `${s}×${n}`).join(", ")}`)
  console.log(`URLs with query params: ${withParams}`)
  console.log(`URLs with forms: ${withForms}`)
}

interface TreeNode {
  name: string
  page?: Page
  children: Map<string, TreeNode>
}

function buildTree(pages: Page[]): TreeNode {
  const root: TreeNode = { name: "/", children: new Map() }
  for (const p of pages) {
    let u: URL
    try {
      u = new URL(p.url)
    } catch {
      continue
    }
    const parts = u.pathname.split("/").filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, children: new Map() }
        node.children.set(part, child)
      }
      node = child
      if (i === parts.length - 1) node.page = p
    }
    if (parts.length === 0) root.page = p
  }
  return root
}

function printTree(node: TreeNode, depth: number) {
  const indent = "  ".repeat(depth)
  const meta = node.page
    ? ` [${node.page.status ?? "?"}${node.page.params.length ? " ?" + node.page.params.join("&") : ""}${
        node.page.forms.length ? " 📝" + node.page.forms.length : ""
      }]`
    : ""
  console.log(`${indent}- /${node.name}${meta}`)
  for (const child of node.children.values()) printTree(child, depth + 1)
}

function usage(code: number): never {
  console.error(`site-crawler.ts --url URL [flags]

Required:
  --url URL                start URL

Scope:
  --include-subdomains     follow same-eTLD+1
  --include  GLOB          path glob to include (repeatable)
  --exclude  GLOB          path glob to exclude (repeatable)
  --ignore-robots          do not honour robots.txt sitemap entries

Limits:
  --max-depth N            default 3
  --max-pages N            default 200, hard cap 5000
  --rate-limit N           req/s, default 8
  --timeout MS             default 12000

Auth:
  --header "K: V"          repeatable
  --basic-auth user:pass

Allow private:
  --allow-private

Output:
  default                  markdown tree
  --json                   structured array of pages
  --csv                    flat csv

`)
  process.exit(code)
}
