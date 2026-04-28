#!/usr/bin/env bun
/**
 * fetch-url.ts — fetch a URL and emit a clean markdown excerpt.
 *
 * Designed to chain after web-search.ts: agent runs a search, picks the
 * top hit, then runs `fetch-url <url>` to actually read the page without
 * having to parse raw HTML in its own context.
 *
 * What we do:
 *   1. Fetch the URL with a desktop UA + timeout.
 *   2. Strip <script>, <style>, <nav>, <header>, <footer>, <aside>,
 *      <noscript>, <svg>, comments, and inline events. The goal is
 *      to keep the article content + code blocks, drop the chrome.
 *   3. Convert headings, paragraphs, lists, code blocks, and links
 *      to markdown via a small built-in HTML→MD pass (no external
 *      dep — keeps this tool zero-install).
 *   4. Truncate to `--max-bytes` (default 32 KB ≈ 8k tokens) so a
 *      runaway page doesn't blow the agent's context.
 *
 * Usage:
 *   bun fetch-url.ts https://example.com/post
 *   bun fetch-url.ts --max-bytes=16000 https://...
 *   bun fetch-url.ts --raw https://...           # raw HTML, no transform
 *   bun fetch-url.ts --json https://...          # {url, title, markdown}
 *
 * Limits and caveats: we don't render JavaScript. SPAs that lazy-load
 * their content client-side will give back the loading skeleton. For
 * those, run with --raw and try a more JS-aware tool, or fetch the
 * site's RSS/JSON feed if available.
 */
import { argv } from "node:process"

const args = argv.slice(2)
const json = args.includes("--json")
const raw = args.includes("--raw")
const maxBytes = parseFlag(args, "max-bytes", 32_000)
const url = args.find((a) => !a.startsWith("--"))

if (!url) {
  console.error("usage: fetch-url.ts [--json] [--raw] [--max-bytes=N] <url>")
  process.exit(2)
}
if (!/^https?:\/\//.test(url)) {
  console.error("✗ url must start with http:// or https://")
  process.exit(2)
}

try {
  const res = await fetchWithTimeout(url)
  if (!res.ok) {
    console.error(`✗ HTTP ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  const html = await res.text()
  if (raw) {
    console.log(html.slice(0, maxBytes))
    process.exit(0)
  }
  const title = extractTitle(html) ?? url
  const md = htmlToMarkdown(html)
  const trimmed = md.length > maxBytes ? md.slice(0, maxBytes) + `\n\n…[truncated to ${maxBytes} bytes]…` : md
  if (json) {
    console.log(JSON.stringify({ url, title, markdown: trimmed }, null, 2))
  } else {
    console.log(`# ${title}\n\n_Source: ${url}_\n\n${trimmed}`)
  }
} catch (err) {
  console.error("✗ fetch failed:", err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchWithTimeout(u: string, ms = 15_000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(u, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    })
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Title + content extraction
// ---------------------------------------------------------------------------

function extractTitle(html: string): string | null {
  // Prefer og:title (richer) → twitter:title → <title>.
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (og) return decode(og[1]).trim()
  const tw = /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (tw) return decode(tw[1]).trim()
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return t ? decode(t[1]).trim() : null
}

function htmlToMarkdown(html: string): string {
  let s = html

  // 1. Drop chrome elements (head, scripts, styles, navigation, etc.)
  s = s.replace(/<!--[\s\S]*?-->/g, "")
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "")
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "")
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, "")
  s = s.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, "")

  // 2. Try to isolate the main content. Sites often wrap the article in
  //    <main>, <article>, or a div with role="main" or itemprop="articleBody".
  //    If we find one, scope to it; otherwise keep the whole body.
  const article =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(s) ||
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(s) ||
    /<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i.exec(s) ||
    /<div[^>]+itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/div>/i.exec(s)
  if (article) s = article[1]

  // 3. Convert structural elements to markdown. Order matters — headings
  //    and code blocks first so their contents aren't re-processed.
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    // Strip nested <code> tags but keep contents.
    const inner = code.replace(/<\/?code[^>]*>/gi, "")
    return "\n```\n" + decode(stripTags(inner)) + "\n```\n"
  })
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => "`" + decode(stripTags(c)) + "`")

  // Headings
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, t) => {
    const hash = "#".repeat(Number(lvl))
    return `\n\n${hash} ${decode(stripTags(t)).trim()}\n\n`
  })

  // Lists (flat — nested ULs collapse but content survives)
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${decode(stripTags(t)).trim()}\n`)
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n")

  // Blockquotes
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => {
    return decode(stripTags(t))
      .split("\n")
      .map((line) => "> " + line)
      .join("\n")
  })

  // Links: keep text + URL
  s = s.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
    const text = decode(stripTags(txt)).trim()
    if (!text) return href
    if (text === href) return href
    return `[${text}](${href})`
  })

  // Bold/italic/strong/em
  s = s.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t) => `**${decode(stripTags(t))}**`)
  s = s.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t) => `*${decode(stripTags(t))}*`)

  // Paragraphs + line breaks
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/p>/gi, "\n\n")

  // Strip everything else
  s = stripTags(s)
  s = decode(s)

  // Collapse excessive whitespace.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return s
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
}

function parseFlag(args: string[], name: string, dflt: number): number {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (!a) return dflt
  const n = Number.parseInt(a.split("=")[1] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
