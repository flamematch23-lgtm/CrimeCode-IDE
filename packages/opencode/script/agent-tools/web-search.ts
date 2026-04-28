#!/usr/bin/env bun
/**
 * web-search.ts — live web search for the agent.
 *
 * Why this exists: agents need to look up current docs, recent CVEs,
 * library API references, and "is this a known issue" before guessing.
 * The shell-out cost is real but the alternative — agent confidently
 * inventing API methods that don't exist — is much worse.
 *
 * Backend selection (in priority order):
 *   1. Brave Search API   — set BRAVE_SEARCH_API_KEY (1k/month free tier).
 *      Best quality, JSON, no scraping. Use this when you can.
 *   2. SearXNG instance   — set SEARXNG_URL (self-hosted, no API key).
 *      Privacy-preserving, decent quality, runs in your homelab.
 *   3. DuckDuckGo HTML    — no key required, default fallback.
 *      Scrape-based: brittle when DDG changes their HTML, but works
 *      out-of-the-box for new agents that haven't configured anything.
 *
 * Usage:
 *   bun web-search.ts "your query"
 *   bun web-search.ts --limit 5 "your query"
 *   bun web-search.ts --json "your query"        # machine-readable
 *   bun web-search.ts --site=github.com "rust async"
 *
 * Output (text): each result on three lines — title, URL, snippet — with a
 * blank line between results. Easy for the agent to read with `head -20`.
 *
 * Output (--json): a JSON array `[{title, url, snippet}, …]` so a wrapping
 * tool can post-process (rerank, dedupe by domain, follow with fetch-url).
 */
import { argv } from "node:process"

interface SearchResult {
  title: string
  url: string
  snippet: string
}

const args = argv.slice(2)
const json = args.includes("--json")
const limit = parseLimit(args) ?? 8
const siteFilter = parseSite(args)
const query = args.filter((a) => !a.startsWith("--")).join(" ").trim()

if (!query) {
  console.error("usage: web-search.ts [--json] [--limit N] [--site=domain.com] <query>")
  process.exit(2)
}

const finalQuery = siteFilter ? `${query} site:${siteFilter}` : query

const backend = pickBackend()

try {
  const results = await runSearch(backend, finalQuery, limit)
  if (results.length === 0) {
    if (json) console.log("[]")
    else console.log(`(no results for "${finalQuery}")`)
    process.exit(0)
  }
  if (json) {
    console.log(JSON.stringify(results.slice(0, limit), null, 2))
  } else {
    console.log(`# Web search — backend: ${backend} — ${results.length} result(s) for "${finalQuery}"\n`)
    for (const r of results.slice(0, limit)) {
      console.log(r.title)
      console.log(r.url)
      console.log(`  ${r.snippet.replace(/\s+/g, " ").slice(0, 220)}`)
      console.log()
    }
  }
} catch (err) {
  console.error(`✗ search failed (${backend}):`, err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Backend dispatch
// ---------------------------------------------------------------------------

function pickBackend(): "brave" | "searxng" | "duckduckgo" {
  if (process.env.BRAVE_SEARCH_API_KEY) return "brave"
  if (process.env.SEARXNG_URL) return "searxng"
  return "duckduckgo"
}

async function runSearch(
  backend: "brave" | "searxng" | "duckduckgo",
  q: string,
  n: number,
): Promise<SearchResult[]> {
  if (backend === "brave") return braveSearch(q, n)
  if (backend === "searxng") return searxngSearch(q, n)
  return duckduckgoSearch(q, n)
}

// ---------------------------------------------------------------------------
// Brave Search API — preferred backend
// https://api.search.brave.com/app/documentation/web-search/get-started
// ---------------------------------------------------------------------------

async function braveSearch(q: string, n: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY!
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(n, 20)}`
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  })
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}: ${await res.text().catch(() => "")}`)
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  return (data.web?.results ?? []).map((r) => ({
    title: stripHtml(r.title ?? ""),
    url: r.url ?? "",
    snippet: stripHtml(r.description ?? ""),
  }))
}

// ---------------------------------------------------------------------------
// SearXNG — self-hosted privacy-preserving meta-search
// ---------------------------------------------------------------------------

async function searxngSearch(q: string, n: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL!.replace(/\/+$/, "")
  const url = `${base}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}: ${await res.text().catch(() => "")}`)
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  return (data.results ?? [])
    .slice(0, n)
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }))
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML scrape — zero-config fallback
//
// Uses the HTML endpoint (no JS required) at html.duckduckgo.com.
// Brittle by nature — if DDG changes their markup this breaks. We
// keep selectors permissive and document them so the next breakage
// is easy to fix.
// ---------------------------------------------------------------------------

async function duckduckgoSearch(q: string, n: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const res = await fetchWithTimeout(url, {
    headers: {
      // Without a real-looking UA DDG returns an empty page or rate-limits
      // immediately. The string below is a current Chrome on Windows.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  })
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`)
  const html = await res.text()
  return parseDuckDuckGoHtml(html, n)
}

function parseDuckDuckGoHtml(html: string, n: number): SearchResult[] {
  // DDG result blocks are <div class="result"> with a <h2><a class="result__a"
  // href="...">Title</a></h2> and a <a class="result__snippet">. We use a
  // permissive regex pass; it's resilient to attribute reordering and
  // whitespace, and degrades gracefully if a single result is malformed.
  const out: SearchResult[] = []
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && out.length < n) {
    const block = m[1]
    const titleM = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!titleM) continue
    let url = decodeHtml(titleM[1])
    // DDG wraps URLs in their /l/?uddg=... redirect — unwrap.
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    const title = stripHtml(titleM[2]).trim()
    const snipM = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const snippet = snipM ? stripHtml(snipM[1]).trim() : ""
    if (!title || !url) continue
    out.push({ title, url, snippet })
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLimit(args: string[]): number | null {
  const idx = args.findIndex((a) => a === "--limit" || a.startsWith("--limit="))
  if (idx < 0) return null
  const raw = args[idx].includes("=") ? args[idx].split("=")[1] : args[idx + 1]
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseSite(args: string[]): string | null {
  const a = args.find((x) => x.startsWith("--site="))
  return a ? a.slice("--site=".length) : null
}

async function fetchWithTimeout(url: string, init?: RequestInit, ms = 12_000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
}

function decodeHtml(s: string): string {
  return stripHtml(s)
}
