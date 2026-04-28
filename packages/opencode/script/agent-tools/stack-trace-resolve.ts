#!/usr/bin/env bun
/**
 * stack-trace-resolve.ts — parse a stack trace, resolve frames to source.
 *
 * Stack traces from production logs are dense and hard to read. This tool
 * takes a trace on stdin, parses it across the major runtimes (Node/Bun,
 * Deno, Python, Go, Rust, Java), and for each frame:
 *   - Locates the file in the current repo (relative + absolute resolution)
 *   - Prints a 5-line code excerpt centered on the line number
 *   - Highlights the offending line with `>>>`
 *
 * Designed to be a one-shot triage step: paste a trace, get back a
 * minimal "what was going on at each frame" view without bouncing
 * between editor + log viewer.
 *
 * Usage:
 *   pbpaste | bun stack-trace-resolve.ts
 *   bun stack-trace-resolve.ts < trace.txt
 *   bun stack-trace-resolve.ts --context 3 < trace.txt   # ±3 lines
 *   bun stack-trace-resolve.ts --json < trace.txt
 *
 * Caveats: source-map resolution for minified JS isn't done here — we
 * assume the agent runs in the same repo whose source is referenced.
 * For minified production traces, run sourcemap-resolve first.
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve as resolvePath, isAbsolute } from "node:path"
import { argv, stdin } from "node:process"

interface Frame {
  raw: string
  function?: string
  file?: string
  line?: number
  column?: number
  resolved?: string
  excerpt?: string
}

const args = argv.slice(2)
const json = args.includes("--json")
const context = parseFlag(args, "context", 2)

const trace = await readStdin()
if (!trace.trim()) {
  console.error("usage: stack-trace-resolve.ts [--json] [--context N] < trace")
  process.exit(2)
}

const frames = parseFrames(trace)
const cwd = process.cwd()

for (const f of frames) {
  if (!f.file) continue
  const abs = resolveFile(f.file, cwd)
  if (!abs) continue
  f.resolved = abs
  if (f.line) f.excerpt = readExcerpt(abs, f.line, context)
}

if (json) {
  console.log(JSON.stringify(frames, null, 2))
  process.exit(0)
}

if (frames.length === 0) {
  console.log("(no frames recognised — supported: Node/Bun, Deno, Python, Go, Rust, Java)")
  process.exit(0)
}

console.log(`# Stack trace — ${frames.length} frame(s)\n`)
for (let i = 0; i < frames.length; i++) {
  const f = frames[i]
  const fnLabel = f.function ? ` ${f.function}` : ""
  const where = f.file
    ? `${f.file}${f.line ? ":" + f.line + (f.column ? ":" + f.column : "") : ""}`
    : "(no source location)"
  console.log(`#${i}${fnLabel}  →  ${where}`)
  if (f.resolved && f.resolved !== f.file) {
    console.log(`     resolved: ${f.resolved}`)
  }
  if (f.excerpt) {
    console.log(f.excerpt)
  } else if (f.file && !f.resolved) {
    console.log("     (file not in this repo)")
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseFrames(trace: string): Frame[] {
  const out: Frame[] = []
  for (const lineRaw of trace.split("\n")) {
    const line = lineRaw.trim()
    if (!line) continue
    const f = parseLine(line)
    if (f) out.push(f)
  }
  return out
}

function parseLine(line: string): Frame | null {
  // Node/Bun:  at functionName (file:line:col)   or   at file:line:col
  let m = /^at\s+(?:(.+?)\s+)?\(?((?:file:\/\/)?[^()]+):(\d+):(\d+)\)?$/.exec(line)
  if (m) {
    return {
      raw: line,
      function: m[1] || undefined,
      file: m[2].replace(/^file:\/\//, ""),
      line: Number(m[3]),
      column: Number(m[4]),
    }
  }

  // Python:   File "path", line 42, in function
  m = /^File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(.+)$/.exec(line)
  if (m) {
    return { raw: line, file: m[1], line: Number(m[2]), function: m[3] }
  }

  // Go:    package.Function(...)
  //          /path/to/file.go:42 +0x12
  m = /^([\w./]+\.[\w()*]+)\(.*\)$/.exec(line)
  if (m) return { raw: line, function: m[1] }
  m = /^\s*([\/\w.\-]+\.go):(\d+)/.exec(line)
  if (m) return { raw: line, file: m[1], line: Number(m[2]) }

  // Rust:    0: function
  //                at file:line
  m = /^\d+:\s+(.+)$/.exec(line)
  if (m) return { raw: line, function: m[1] }
  m = /^at\s+([\w./\\:-]+):(\d+)$/.exec(line)
  if (m) return { raw: line, file: m[1], line: Number(m[2]) }

  // Java/Kotlin:  at pkg.Class.method(File.java:42)
  m = /^at\s+([\w$.]+)\(([^:]+):(\d+)\)$/.exec(line)
  if (m) return { raw: line, function: m[1], file: m[2], line: Number(m[3]) }

  return null
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function resolveFile(file: string, cwd: string): string | null {
  // Cygwin / Git-Bash paths look like /c/Users/foo/bar — convert to a Windows
  // absolute path before checking. Without this every trace from a CI on
  // Windows misses the file and falls through to the basename glob, which
  // can resolve to a different file with the same name (test fixtures, etc).
  const cygwin = /^\/([a-zA-Z])\/(.*)/.exec(file)
  if (cygwin && process.platform === "win32") {
    const win = `${cygwin[1].toUpperCase()}:\\${cygwin[2].replace(/\//g, "\\")}`
    if (existsSync(win)) return win
  }
  // Try absolute, then relative to cwd, then look for the basename anywhere
  // under cwd (for monorepos where the trace shows /tmp/build/.../foo.ts).
  if (isAbsolute(file) && existsSync(file)) return file
  const rel = resolvePath(cwd, file)
  if (existsSync(rel)) return rel
  // Try matching by basename — useful for /tmp/builds/ paths.
  const base = file.split(/[\\/]/).pop()
  if (!base) return null
  // Use a quick `find` via Bun's glob — capped at first match to keep it fast.
  try {
    // Bun has `Bun.glob` since 1.x.
    const glob = (Bun as unknown as { Glob: new (p: string) => { scanSync: (o: { cwd: string }) => Iterable<string> } }).Glob
    if (typeof glob === "function") {
      const g = new glob(`**/${base}`)
      for (const hit of g.scanSync({ cwd })) {
        const full = resolvePath(cwd, hit)
        if (existsSync(full)) return full
      }
    }
  } catch {
    /* fall through */
  }
  return null
}

function readExcerpt(path: string, lineNum: number, ctx: number): string {
  let lines: string[]
  try {
    lines = readFileSync(path, "utf8").split("\n")
  } catch {
    return ""
  }
  const start = Math.max(1, lineNum - ctx)
  const end = Math.min(lines.length, lineNum + ctx)
  const width = String(end).length
  const out: string[] = []
  for (let i = start; i <= end; i++) {
    const marker = i === lineNum ? ">>>" : "   "
    const num = String(i).padStart(width, " ")
    out.push(`     ${marker} ${num} | ${lines[i - 1] ?? ""}`)
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const reader = (stdin as unknown as { stream(): ReadableStream<Uint8Array> }).stream
    ? (stdin as unknown as { stream(): ReadableStream<Uint8Array> }).stream().getReader()
    : null
  if (reader) {
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  // Fallback for older runtimes.
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    stdin.on("data", (c) => chunks.push(c as Buffer))
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

function parseFlag(args: string[], name: string, dflt: number): number {
  const a = args.find((x) => x.startsWith(`--${name}=`)) ?? args[args.indexOf(`--${name}`) + 1]
  if (!a) return dflt
  const v = a.startsWith("--") ? a.split("=")[1] : a
  const n = Number.parseInt(v ?? "", 10)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}
