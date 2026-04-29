#!/usr/bin/env bun
/**
 * token-sequencer.ts — Burp Suite Sequencer equivalent.
 *
 * Collect a sample of session/auth tokens (cookies, JWTs, CSRF tokens,
 * password-reset tokens, anything sequence-y), then run randomness +
 * structural analysis on them to spot weak generators.
 *
 * Modes:
 *
 *   collect  fire N requests against a URL, extract a token each time,
 *            persist samples to disk for later analysis
 *
 *   analyse  run statistics on a previously-collected sample (or stdin)
 *            — Shannon entropy per char-position, FIPS-140-1 monobit/
 *            poker/runs (relaxed thresholds — these were intended for
 *            hardware RNGs but flag obvious garbage), character-set
 *            distribution, and structural similarity (do tokens share
 *            a static prefix/suffix? are some bits constant?)
 *
 *   live     collect → analyse pipeline, prints rolling stats while
 *            collecting (useful when you don't know ahead of time how
 *            many samples you need)
 *
 * Usage:
 *
 *   # Collect 200 tokens from a login endpoint, extract from Set-Cookie
 *   bun token-sequencer.ts collect \
 *     --url https://target/login --method POST --body '...' \
 *     --extract 'header:set-cookie' --pattern 'session=([^;]+)' \
 *     --count 200 --concurrency 4 \
 *     --out tokens.txt
 *
 *   # Analyse what's already on disk
 *   bun token-sequencer.ts analyse --in tokens.txt
 *
 *   # Or pipe in
 *   cat tokens.txt | bun token-sequencer.ts analyse
 *
 *   # Live mode
 *   bun token-sequencer.ts live --url ... --count 500 --extract body --pattern '"token":"([^"]+)"'
 *
 * Output: human-readable summary + per-position bit/char heatmap.
 *   --json: full machine-readable result.
 */
import { argv } from "node:process"
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs"
import { performance } from "node:perf_hooks"
import {
  bail,
  ensureHostAllowed,
  info,
  makeArgs,
  ok,
  readStdin,
  shannonEntropy,
} from "./_lib/common.ts"

const cli = makeArgs(argv)
const mode = cli.args[0]
const json = cli.has("--json")

if (!mode || ["--help", "-h"].includes(mode)) usage(0)

if (mode === "collect") await runCollect()
else if (mode === "analyse" || mode === "analyze") await runAnalyse()
else if (mode === "live") await runLive()
else usage(2)

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

async function runCollect() {
  const samples = await collect(parseCollectOpts())
  const out = cli.flag("out")
  if (out) {
    writeFileSync(out, samples.join("\n"))
    ok(`wrote ${samples.length} samples → ${out}`)
  } else {
    for (const s of samples) console.log(s)
  }
}

interface CollectOpts {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  count: number
  concurrency: number
  rateLimit: number
  timeoutMs: number
  extract: "header" | "body" | "set-cookie"
  headerName?: string
  pattern: RegExp
  allowPrivate: boolean
}

function parseCollectOpts(): CollectOpts {
  const url = cli.required("url")
  const method = (cli.flag("method") ?? "GET").toUpperCase()
  const body = cli.flag("body") ?? undefined
  const count = cli.num("count", 200)
  const concurrency = cli.num("concurrency", Math.min(8, count))
  const rateLimit = cli.num("rate-limit", 20)
  const timeoutMs = cli.num("timeout", 15_000)
  const allowPrivate = cli.has("--allow-private")
  const extractRaw = cli.required("extract") // "body" | "header:NAME" | "set-cookie"
  let extract: CollectOpts["extract"] = "body"
  let headerName: string | undefined
  if (extractRaw === "body") extract = "body"
  else if (extractRaw === "set-cookie") extract = "set-cookie"
  else if (extractRaw.startsWith("header:")) {
    extract = "header"
    headerName = extractRaw.slice("header:".length).toLowerCase()
  } else bail(`bad --extract: ${extractRaw}`)
  const pat = cli.required("pattern")
  let pattern: RegExp
  try {
    pattern = new RegExp(pat)
  } catch (e) {
    bail(`bad --pattern regex: ${e instanceof Error ? e.message : String(e)}`)
  }
  ensureHostAllowed(url, allowPrivate)
  return {
    url,
    method,
    headers: cli.headers(),
    body,
    count,
    concurrency,
    rateLimit,
    timeoutMs,
    extract,
    headerName,
    pattern,
    allowPrivate,
  }
}

async function collect(opts: CollectOpts): Promise<string[]> {
  const samples: string[] = []
  const tickMs = Math.max(50, 1000 / opts.rateLimit)
  let lastTick = 0
  let inflight = 0
  let next = 0
  const queue: Array<Promise<void>> = []
  info(`Collecting ${opts.count} samples at ~${opts.rateLimit} req/s, ${opts.concurrency} concurrent…`)
  while (next < opts.count) {
    while (inflight < opts.concurrency && next < opts.count) {
      const wait = lastTick + tickMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastTick = Date.now()
      next++
      inflight++
      queue.push(
        captureOne(opts)
          .then((token) => {
            if (token) samples.push(token)
            if (samples.length % 25 === 0) info(`  ${samples.length}/${opts.count}`)
          })
          .catch(() => {
            /* skip */
          })
          .finally(() => {
            inflight--
          }),
      )
    }
    await Promise.race(queue)
    queue.splice(0, queue.length - inflight)
  }
  await Promise.all(queue)
  return samples
}

async function captureOne(opts: CollectOpts): Promise<string | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  try {
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: "manual",
      signal: ctrl.signal,
    })
    if (opts.extract === "body") {
      const text = await res.text()
      const m = opts.pattern.exec(text)
      return m?.[1] ?? null
    }
    if (opts.extract === "header") {
      const v = res.headers.get(opts.headerName!)
      if (!v) return null
      const m = opts.pattern.exec(v)
      return m?.[1] ?? null
    }
    if (opts.extract === "set-cookie") {
      const v = res.headers.get("set-cookie")
      if (!v) return null
      const m = opts.pattern.exec(v)
      return m?.[1] ?? null
    }
    return null
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

async function runAnalyse() {
  const tokens = await loadSamples()
  if (tokens.length < 5) bail(`need at least 5 samples (got ${tokens.length})`)
  const report = analyse(tokens)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  printReport(report)
}

async function loadSamples(): Promise<string[]> {
  const inFile = cli.flag("in")
  let raw: string
  if (inFile) {
    if (!existsSync(inFile)) bail(`no such file: ${inFile}`)
    raw = readFileSync(inFile, "utf8")
  } else {
    raw = await readStdin()
  }
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

interface SequencerReport {
  count: number
  uniqueCount: number
  duplicates: number
  lengthMin: number
  lengthMax: number
  lengthMode: number
  charset: string
  charsetSize: number
  shannonOverall: number
  shannonPerPosition: number[]
  staticPrefixLen: number
  staticSuffixLen: number
  perPositionVariety: number[]
  fips: {
    monobitPass: boolean
    pokerPass: boolean
    runsPass: boolean
    longRunPass: boolean
    notes: string[]
  }
  verdict: "STRONG" | "ADEQUATE" | "WEAK" | "BROKEN"
  warnings: string[]
}

function analyse(tokens: string[]): SequencerReport {
  const lens = tokens.map((t) => t.length)
  const lengthMin = Math.min(...lens)
  const lengthMax = Math.max(...lens)
  const lenCounts = new Map<number, number>()
  for (const l of lens) lenCounts.set(l, (lenCounts.get(l) ?? 0) + 1)
  const lengthMode = [...lenCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]

  // Build charset
  const chars = new Set<string>()
  for (const t of tokens) for (const c of t) chars.add(c)
  const charset = [...chars].sort().join("")
  const charsetSize = chars.size

  // Static prefix / suffix
  let staticPrefixLen = 0
  while (staticPrefixLen < lengthMin) {
    const c = tokens[0][staticPrefixLen]
    if (tokens.every((t) => t[staticPrefixLen] === c)) staticPrefixLen++
    else break
  }
  let staticSuffixLen = 0
  while (staticSuffixLen < lengthMin - staticPrefixLen) {
    const c = tokens[0][tokens[0].length - 1 - staticSuffixLen]
    if (tokens.every((t) => t[t.length - 1 - staticSuffixLen] === c)) staticSuffixLen++
    else break
  }

  // Shannon overall (concatenate all tokens)
  const shannonOverall = shannonEntropy(tokens.join(""))

  // Per-position Shannon (only for tokens that share lengthMode)
  const sameLen = tokens.filter((t) => t.length === lengthMode)
  const shannonPerPosition: number[] = []
  const perPositionVariety: number[] = []
  for (let i = 0; i < lengthMode; i++) {
    const col = sameLen.map((t) => t[i]).join("")
    shannonPerPosition.push(Number(shannonEntropy(col).toFixed(3)))
    perPositionVariety.push(new Set(col).size)
  }

  // FIPS-140-1 (loose, applied to the bitstream of base16-decoded tokens
  // when possible, otherwise to the UTF-8 bytes)
  const fips = runFipsTests(sameLen)

  // Verdict
  const warnings: string[] = []
  if (staticPrefixLen >= lengthMode * 0.3) warnings.push(`large static prefix (${staticPrefixLen} chars)`)
  if (staticSuffixLen >= lengthMode * 0.3) warnings.push(`large static suffix (${staticSuffixLen} chars)`)
  if (charsetSize <= 16) warnings.push(`narrow character set (${charsetSize} distinct chars)`)
  const expectedMaxEntropy = Math.log2(charsetSize)
  if (expectedMaxEntropy > 0 && shannonOverall / expectedMaxEntropy < 0.85)
    warnings.push(`low entropy ratio (${(shannonOverall / expectedMaxEntropy).toFixed(2)})`)
  if (perPositionVariety.some((v) => v <= 2)) warnings.push("some positions have ≤ 2 unique values across all samples")
  if (tokens.length - new Set(tokens).size > 0) warnings.push(`${tokens.length - new Set(tokens).size} duplicate token(s)`)

  let verdict: SequencerReport["verdict"] = "STRONG"
  if (warnings.length === 0 && fips.monobitPass && fips.pokerPass && fips.runsPass) {
    verdict = "STRONG"
  } else if (warnings.length <= 1 && [fips.monobitPass, fips.pokerPass, fips.runsPass].filter(Boolean).length >= 2) {
    verdict = "ADEQUATE"
  } else if (warnings.length >= 3 || ![fips.monobitPass, fips.pokerPass, fips.runsPass].some(Boolean)) {
    verdict = "BROKEN"
  } else {
    verdict = "WEAK"
  }

  return {
    count: tokens.length,
    uniqueCount: new Set(tokens).size,
    duplicates: tokens.length - new Set(tokens).size,
    lengthMin,
    lengthMax,
    lengthMode,
    charset,
    charsetSize,
    shannonOverall: Number(shannonOverall.toFixed(3)),
    shannonPerPosition,
    staticPrefixLen,
    staticSuffixLen,
    perPositionVariety,
    fips,
    verdict,
    warnings,
  }
}

function runFipsTests(tokens: string[]): SequencerReport["fips"] {
  const notes: string[] = []
  // Convert to a single bit string. Try hex/base64; fall back to UTF-8.
  const concat = tokens.join("")
  let bytes: Buffer
  if (/^[0-9a-fA-F]+$/.test(concat) && concat.length % 2 === 0) {
    bytes = Buffer.from(concat, "hex")
    notes.push("interpreted samples as hex")
  } else if (/^[A-Za-z0-9+/=_-]+$/.test(concat) && concat.length % 4 <= 1) {
    try {
      bytes = Buffer.from(concat, "base64")
      notes.push("interpreted samples as base64")
    } catch {
      bytes = Buffer.from(concat, "utf8")
      notes.push("interpreted samples as utf8 bytes")
    }
  } else {
    bytes = Buffer.from(concat, "utf8")
    notes.push("interpreted samples as utf8 bytes")
  }

  // Build bit string
  const bits: number[] = []
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
  if (bits.length < 20_000) {
    notes.push(`only ${bits.length} bits (FIPS expects 20 000+); applying loose thresholds`)
  }

  // Monobit (count of 1 bits)
  const ones = bits.filter((b) => b === 1).length
  const monoRatio = ones / bits.length
  const monobitPass = monoRatio > 0.45 && monoRatio < 0.55

  // Poker test (4-bit chunks)
  const chunks = Math.floor(bits.length / 4)
  const counts = new Array(16).fill(0)
  for (let i = 0; i < chunks; i++) {
    let v = 0
    for (let j = 0; j < 4; j++) v = (v << 1) | bits[i * 4 + j]
    counts[v]++
  }
  const sumSq = counts.reduce((a, c) => a + c * c, 0)
  const x = (16 / chunks) * sumSq - chunks
  // Loose threshold: typical FIPS is 1.03 < x < 57.4
  const pokerPass = x > 0.5 && x < 100

  // Runs test
  const runs = countRuns(bits)
  // FIPS bands (relaxed) — make sure we have *some* runs at every length up to 6.
  let runsPass = true
  for (let i = 1; i <= 6; i++) {
    const expected = bits.length / Math.pow(2, i + 1)
    if (Math.abs((runs[i] ?? 0) - expected) > expected * 0.7) runsPass = false
  }

  // Long run
  const maxRun = Math.max(...runs.map((_, i) => i).filter((i) => (runs[i] ?? 0) > 0), 0)
  const longRunPass = maxRun < 26

  return { monobitPass, pokerPass, runsPass, longRunPass, notes }
}

function countRuns(bits: number[]): number[] {
  const runs: number[] = []
  let cur = bits[0] ?? 0
  let len = 1
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === cur) len++
    else {
      runs[len] = (runs[len] ?? 0) + 1
      cur = bits[i]
      len = 1
    }
  }
  runs[len] = (runs[len] ?? 0) + 1
  return runs
}

function printReport(r: SequencerReport) {
  const colour = process.stdout.isTTY && !process.env.NO_COLOR
  const C_RED = colour ? "\x1b[31m" : ""
  const C_YELLOW = colour ? "\x1b[33m" : ""
  const C_GREEN = colour ? "\x1b[32m" : ""
  const C_BOLD = colour ? "\x1b[1m" : ""
  const C_RESET = colour ? "\x1b[0m" : ""
  const verdictColor =
    r.verdict === "STRONG"
      ? C_GREEN
      : r.verdict === "ADEQUATE"
      ? C_YELLOW
      : r.verdict === "WEAK"
      ? C_YELLOW
      : C_RED
  console.log(`# Sequencer report\n`)
  console.log(`Verdict:  ${verdictColor}${C_BOLD}${r.verdict}${C_RESET}`)
  console.log(`Samples:  ${r.count} (${r.uniqueCount} unique, ${r.duplicates} dup)`)
  console.log(`Length:   ${r.lengthMin}–${r.lengthMax} (mode ${r.lengthMode})`)
  console.log(`Charset:  ${r.charsetSize} distinct  ${r.charset.length > 60 ? r.charset.slice(0, 60) + "…" : r.charset}`)
  console.log(`Entropy:  ${r.shannonOverall} bits/char (max ${Math.log2(r.charsetSize).toFixed(2)})`)
  console.log()
  if (r.staticPrefixLen) console.log(`Static prefix: ${r.staticPrefixLen} chars`)
  if (r.staticSuffixLen) console.log(`Static suffix: ${r.staticSuffixLen} chars`)
  console.log()
  console.log(`Per-position variety (mode-length only):`)
  const heat = r.perPositionVariety
    .map((v, i) => {
      const ratio = Math.min(1, v / r.charsetSize)
      const block = ratio < 0.2 ? "▁" : ratio < 0.4 ? "▃" : ratio < 0.6 ? "▅" : ratio < 0.8 ? "▆" : "█"
      return ratio < 0.5 ? `${C_RED}${block}${C_RESET}` : `${C_GREEN}${block}${C_RESET}`
    })
    .join("")
  console.log(`  ${heat}`)
  console.log()
  console.log(`FIPS 140-1 (loose):`)
  console.log(`  monobit:  ${pf(r.fips.monobitPass)}`)
  console.log(`  poker:    ${pf(r.fips.pokerPass)}`)
  console.log(`  runs:     ${pf(r.fips.runsPass)}`)
  console.log(`  long-run: ${pf(r.fips.longRunPass)}`)
  for (const n of r.fips.notes) console.log(`  // ${n}`)
  if (r.warnings.length) {
    console.log()
    console.log(`Warnings:`)
    for (const w of r.warnings) console.log(`  ${C_YELLOW}⚠${C_RESET} ${w}`)
  }

  function pf(b: boolean): string {
    return b ? `${C_GREEN}pass${C_RESET}` : `${C_RED}fail${C_RESET}`
  }
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function runLive() {
  const opts = parseCollectOpts()
  const out = cli.flag("out")
  if (out) writeFileSync(out, "")
  const buffer: string[] = []
  const tickMs = Math.max(50, 1000 / opts.rateLimit)
  let lastTick = 0
  let inflight = 0
  let next = 0
  const queue: Array<Promise<void>> = []
  while (next < opts.count) {
    while (inflight < opts.concurrency && next < opts.count) {
      const wait = lastTick + tickMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastTick = Date.now()
      next++
      inflight++
      queue.push(
        captureOne(opts)
          .then((tok) => {
            if (tok) {
              buffer.push(tok)
              if (out) appendFileSync(out, tok + "\n")
              if (buffer.length % 25 === 0) {
                const r = analyse(buffer)
                info(`  ${buffer.length}: verdict=${r.verdict} entropy=${r.shannonOverall} dup=${r.duplicates}`)
              }
            }
          })
          .catch(() => {
            /* skip */
          })
          .finally(() => {
            inflight--
          }),
      )
    }
    await Promise.race(queue)
    queue.splice(0, queue.length - inflight)
  }
  await Promise.all(queue)
  const r = analyse(buffer)
  if (json) console.log(JSON.stringify(r, null, 2))
  else printReport(r)
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`token-sequencer.ts <mode> [flags]

Modes:
  collect    fire requests, persist tokens
  analyse    statistics on a sample (file or stdin)
  live       collect + analyse rolling

Collect/live flags:
  --url URL                       (required)
  --method GET|POST|...           (default GET)
  --header "K: V"                 (repeatable)
  --body STRING
  --extract body | header:NAME | set-cookie
  --pattern REGEX                 (capture group 1 = the token)
  --count N                       (default 200)
  --concurrency N                 (default min(8, count))
  --rate-limit N                  (req/s, default 20)
  --timeout MS                    (default 15000)
  --allow-private                 allow private/loopback targets
  --out FILE                      append samples here

Analyse flags:
  --in FILE                       (or read tokens, one per line, from stdin)

Common: --json
`)
  process.exit(code)
}
