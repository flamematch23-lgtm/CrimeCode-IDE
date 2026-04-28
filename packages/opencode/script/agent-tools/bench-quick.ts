#!/usr/bin/env bun
/**
 * bench-quick.ts — micro-benchmark a function call. A/B comparison too.
 *
 * Three modes:
 *
 *   single    — bench a single async/sync function. Stats: ops/sec, p50,
 *               p95, p99, median, min, max.
 *   ab        — run two implementations and report the speedup factor +
 *               whether the result is statistically significant
 *               (Welch's t-test, two-tailed, α=0.05).
 *   suite     — bench every function exported from a "bench" file with
 *               name pattern `bench_*` or matching --grep.
 *
 * Designed for "is this change faster?" questions during a refactor,
 * NOT for benchmarking benchmarks. For rigorous, publish-quality numbers
 * use mitata or hyperfine; this is the 30-second answer.
 *
 * Usage:
 *
 *   bun bench-quick.ts single \
 *       --import './my-fn' --fn doWork --warmup 1000 --iter 50000
 *
 *   bun bench-quick.ts ab \
 *       --a './v1#parse' --b './v2#parse' --iter 20000
 *
 *   bun bench-quick.ts suite ./bench/all.ts
 *
 * Reads from process.cwd() — the import path is relative to where you
 * invoke. JSON output via --json.
 */
import { argv } from "node:process"
import { resolve, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

const args = argv.slice(2)
const mode = args[0]
const json = args.includes("--json")

if (!mode || ["--help", "-h"].includes(mode)) usage(0)

if (mode === "single") {
  await runSingle()
} else if (mode === "ab") {
  await runAb()
} else if (mode === "suite") {
  await runSuite(args[1])
} else {
  usage(2)
}

// ---------------------------------------------------------------------------
// Single
// ---------------------------------------------------------------------------

async function runSingle() {
  const importSpec = required("import")
  const fnName = parseFlag("fn") ?? "default"
  const warmup = numFlag("warmup", 1_000)
  const iter = numFlag("iter", 20_000)
  const fn = await resolveFn(importSpec, fnName)

  const stats = await bench(fn, { warmup, iter })
  if (json) {
    console.log(JSON.stringify({ mode: "single", import: importSpec, fn: fnName, ...stats }, null, 2))
  } else {
    console.log(`# ${importSpec}#${fnName} — ${iter.toLocaleString()} ops, ${warmup.toLocaleString()} warmup\n`)
    printStats(stats)
  }
}

// ---------------------------------------------------------------------------
// A/B
// ---------------------------------------------------------------------------

async function runAb() {
  const a = parseTarget(required("a"))
  const b = parseTarget(required("b"))
  const warmup = numFlag("warmup", 1_000)
  const iter = numFlag("iter", 20_000)

  const aFn = await resolveFn(a.spec, a.fn)
  const bFn = await resolveFn(b.spec, b.fn)

  const aStats = await bench(aFn, { warmup, iter, recordSamples: true })
  const bStats = await bench(bFn, { warmup, iter, recordSamples: true })

  // Welch's t-test for two-sample, equal mean H0.
  const t = welchT(aStats.samples!, bStats.samples!)
  const significant = Math.abs(t) > 1.96 // approx z for α=0.05 two-tailed
  const speedup = aStats.medianUs / bStats.medianUs // >1 means b is faster

  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: "ab",
          a: { ...a, ...stripSamples(aStats) },
          b: { ...b, ...stripSamples(bStats) },
          speedup_b_over_a: speedup,
          welch_t: t,
          significant_at_5pct: significant,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`# A/B — ${a.spec}#${a.fn}  vs  ${b.spec}#${b.fn}\n`)
    console.log(`Iter: ${iter.toLocaleString()} per side, warmup: ${warmup.toLocaleString()}\n`)
    console.log(`A  →  ${a.spec}#${a.fn}`)
    printStats(stripSamples(aStats))
    console.log()
    console.log(`B  →  ${b.spec}#${b.fn}`)
    printStats(stripSamples(bStats))
    console.log()
    const verdict = speedup > 1
      ? `B is ${speedup.toFixed(2)}× faster than A`
      : `A is ${(1 / speedup).toFixed(2)}× faster than B`
    console.log(`📊 ${verdict}`)
    console.log(`   Welch's t = ${t.toFixed(2)}, ${significant ? "✅ significant" : "❌ not significant"} at α=0.05`)
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function runSuite(file?: string) {
  if (!file) bail("usage: bench-quick.ts suite <file>")
  const grep = parseFlag("grep")
  const warmup = numFlag("warmup", 200)
  const iter = numFlag("iter", 5_000)
  const mod = await import(toFileUrl(file!))
  const entries = Object.entries(mod).filter(
    ([name, val]) =>
      typeof val === "function" && (grep ? new RegExp(grep).test(name) : name.startsWith("bench_") || name.startsWith("bench")),
  )
  if (entries.length === 0) bail("no matching bench functions found")
  const rows: Array<{ name: string; ops_sec: number; p50_us: number; p95_us: number }> = []
  for (const [name, fn] of entries) {
    const stats = await bench(fn as () => unknown, { warmup, iter })
    rows.push({
      name,
      ops_sec: stats.opsPerSec,
      p50_us: stats.medianUs,
      p95_us: stats.p95Us,
    })
  }
  if (json) {
    console.log(JSON.stringify({ mode: "suite", file, entries: rows }, null, 2))
  } else {
    console.log(`# Suite — ${file}  (${entries.length} benchmark(s))\n`)
    const w = Math.max(...rows.map((r) => r.name.length))
    for (const r of rows) {
      console.log(
        `${r.name.padEnd(w)}  ${r.ops_sec.toFixed(0).padStart(10)} ops/s   p50=${r.p50_us.toFixed(2)}µs   p95=${r.p95_us.toFixed(2)}µs`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Bench engine
// ---------------------------------------------------------------------------

interface BenchOpts {
  warmup: number
  iter: number
  recordSamples?: boolean
}

interface BenchStats {
  iter: number
  totalMs: number
  opsPerSec: number
  meanUs: number
  medianUs: number
  p50Us: number
  p95Us: number
  p99Us: number
  minUs: number
  maxUs: number
  /** Per-iteration time in microseconds (only when recordSamples). */
  samples?: number[]
}

async function bench(fn: () => unknown | Promise<unknown>, opts: BenchOpts): Promise<BenchStats> {
  // Detect async by sniffing — call once and see if we got a Promise.
  let probe: unknown
  try {
    probe = fn()
  } catch (e) {
    bail(`bench fn threw on first call: ${e instanceof Error ? e.message : String(e)}`)
  }
  const isAsync = probe && typeof (probe as { then?: unknown }).then === "function"
  if (isAsync) await probe

  // Warmup — discard timings.
  for (let i = 0; i < opts.warmup; i++) {
    if (isAsync) await fn()
    else fn()
  }

  // Hot loop with per-iter timestamps.
  const samples: number[] = opts.recordSamples ? new Array(opts.iter) : []
  const t0 = performance.now()
  if (opts.recordSamples) {
    for (let i = 0; i < opts.iter; i++) {
      const a = performance.now()
      if (isAsync) await fn()
      else fn()
      const b = performance.now()
      samples[i] = (b - a) * 1000 // µs
    }
  } else {
    for (let i = 0; i < opts.iter; i++) {
      if (isAsync) await fn()
      else fn()
    }
  }
  const totalMs = performance.now() - t0
  const totalUs = totalMs * 1000

  let meanUs = totalUs / opts.iter
  let medianUs = meanUs
  let p95Us = meanUs
  let p99Us = meanUs
  let minUs = meanUs
  let maxUs = meanUs

  if (samples.length > 0) {
    const sorted = [...samples].sort((a, b) => a - b)
    medianUs = sorted[Math.floor(sorted.length * 0.5)]
    p95Us = sorted[Math.floor(sorted.length * 0.95)]
    p99Us = sorted[Math.floor(sorted.length * 0.99)]
    minUs = sorted[0]
    maxUs = sorted[sorted.length - 1]
    meanUs = sorted.reduce((a, b) => a + b, 0) / sorted.length
  }

  const stats: BenchStats = {
    iter: opts.iter,
    totalMs,
    opsPerSec: opts.iter / (totalMs / 1000),
    meanUs,
    medianUs,
    p50Us: medianUs,
    p95Us,
    p99Us,
    minUs,
    maxUs,
  }
  if (opts.recordSamples) stats.samples = samples
  return stats
}

function welchT(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length
  const mb = b.reduce((x, y) => x + y, 0) / b.length
  const va = a.reduce((x, y) => x + (y - ma) * (y - ma), 0) / (a.length - 1)
  const vb = b.reduce((x, y) => x + (y - mb) * (y - mb), 0) / (b.length - 1)
  const denom = Math.sqrt(va / a.length + vb / b.length)
  if (denom === 0) return 0
  return (ma - mb) / denom
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printStats(s: BenchStats) {
  console.log(`  ops/sec : ${s.opsPerSec.toFixed(0)}`)
  console.log(`  total   : ${s.totalMs.toFixed(2)} ms`)
  console.log(`  mean    : ${s.meanUs.toFixed(2)} µs`)
  console.log(`  median  : ${s.medianUs.toFixed(2)} µs`)
  console.log(`  p95     : ${s.p95Us.toFixed(2)} µs`)
  console.log(`  p99     : ${s.p99Us.toFixed(2)} µs`)
  console.log(`  min     : ${s.minUs.toFixed(2)} µs`)
  console.log(`  max     : ${s.maxUs.toFixed(2)} µs`)
}

function stripSamples(s: BenchStats): BenchStats {
  const { samples: _samples, ...rest } = s
  return rest
}

interface Target {
  spec: string
  fn: string
}

function parseTarget(raw: string): Target {
  const idx = raw.lastIndexOf("#")
  if (idx < 0) return { spec: raw, fn: "default" }
  return { spec: raw.slice(0, idx), fn: raw.slice(idx + 1) }
}

async function resolveFn(spec: string, fnName: string): Promise<() => unknown | Promise<unknown>> {
  const url = toFileUrl(spec)
  let mod: Record<string, unknown>
  try {
    mod = (await import(url)) as Record<string, unknown>
  } catch (e) {
    bail(`failed to import ${spec}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const fn = fnName === "default" ? (mod.default as unknown) : mod[fnName]
  if (typeof fn !== "function") bail(`${spec} has no callable export "${fnName}"`)
  return fn as () => unknown
}

function toFileUrl(spec: string): string {
  // Bun handles bare module specifiers via its resolver; only convert
  // relative paths and absolute fs paths to file:// URLs.
  if (spec.startsWith(".") || isAbsolute(spec)) {
    return pathToFileURL(resolve(process.cwd(), spec)).href
  }
  return spec
}

function parseFlag(name: string): string | null {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (a) return a.slice(`--${name}=`.length)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
  return null
}

function numFlag(name: string, dflt: number): number {
  const v = parseFlag(name)
  if (v == null) return dflt
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

function required(name: string): string {
  const v = parseFlag(name)
  if (v == null) bail(`missing --${name}`)
  return v as string
}

function bail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

function usage(code: number): never {
  console.error(`bench-quick.ts <mode> [flags]

Modes:
  single  --import <spec> --fn <name>    [--warmup N] [--iter N]
  ab      --a <spec#fn>   --b <spec#fn>  [--warmup N] [--iter N]
  suite   <file>          [--grep RE]    [--warmup N] [--iter N]

Common: --json
`)
  process.exit(code)
}
