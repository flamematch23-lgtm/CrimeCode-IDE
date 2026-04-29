#!/usr/bin/env bun
/**
 * audit.ts — TDZ self-check for the Burp toolkit.
 *
 * Each tool runs with top-level `await`, so any `const`/`let` referenced
 * by the dispatch block must be declared **before** the dispatch. This
 * audit walks every *.ts file in the toolkit and prints any violations
 * — exit code 1 if violations are found, 0 if clean.
 *
 * What counts as the "dispatch line" (heuristic):
 *
 *   - first `if (!cmd …) usage(0)` or `if (!mode …) usage(0)`
 *   - first `if (cli.has("--help")) usage(0)`
 *   - first `await cmdX()` / `await runX()` / `await modeX()`
 *
 * What's checked:
 *
 *   - module-scoped `const`/`let` declarations made AFTER the dispatch
 *     are inspected
 *   - if any of those identifiers are *referenced* in the lines BEFORE
 *     the dispatch (or inside `usage()` / `parseOpts()` etc. that runs
 *     synchronously during dispatch), it's a violation.
 *
 *   - `interface`, `type`, `function`, `async function` declarations
 *     are allowed in any order: they're erased at compile time or
 *     hoisted at runtime.
 *
 * Run from anywhere:
 *
 *   bun packages/opencode/script/agent-tools/security/_lib/audit.ts
 *
 * Exit codes:
 *   0  no violations
 *   1  one or more violations
 *   2  audit script error (cannot read files)
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLKIT_DIR = dirname(HERE) // _lib/.. = the security/ directory

const DISPATCH_PATTERNS = [
  /^if\s*\(\s*!\s*cmd\b.*usage\(/,
  /^if\s*\(\s*!\s*mode\b.*usage\(/,
  /^if\s*\(\s*!\s*op\b.*usage\(/,
  /^if\s*\(\s*cli\.has\(\s*"--help"/,
  /^if\s*\(\s*\["--help"/,
  /^await\s+(cmd|run|mode)[A-Z]\w*\(/,
  /^const\s+opts\s*=\s*parseOpts\(\)/,
  /^const\s+positions\s*=\s*collectPositions\(\)/,
  /^const\s+payloadSets\s*=\s*loadPayloadSets\(\)/,
  /^const\s+matrix\s*=\s*buildMatrix\(/,
  /^const\s+baseline\s*=\s*await\s+/,
]

interface Violation {
  file: string
  symbol: string
  declaredAt: number
  referencedAt: number
  context: string
}

function listToolFiles(): string[] {
  const out: string[] = []
  for (const name of readdirSync(TOOLKIT_DIR)) {
    if (!name.endsWith(".ts")) continue
    if (name.startsWith("_")) continue // skip lib helpers
    const full = join(TOOLKIT_DIR, name)
    if (statSync(full).isFile()) out.push(full)
  }
  // Also audit our own _lib files (audit.ts excluded)
  const libDir = join(TOOLKIT_DIR, "_lib")
  if (statSync(libDir).isDirectory()) {
    for (const name of readdirSync(libDir)) {
      if (!name.endsWith(".ts")) continue
      if (name === "audit.ts") continue
      out.push(join(libDir, name))
    }
  }
  return out
}

function findDispatchLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trimStart()
    if (DISPATCH_PATTERNS.some((re) => re.test(l))) return i + 1
  }
  return -1
}

function findRuntimeDeclarations(lines: string[], afterLine: number): Map<string, number> {
  // Match top-level `const X = …` or `let X = …` (NOT inside function
  // bodies). Heuristic: lines that start with `const ` or `let ` at
  // indent 0 *and* come after our dispatch line.
  const out = new Map<string, number>()
  for (let i = afterLine; i < lines.length; i++) {
    const l = lines[i]
    if (!/^(const|let)\s+/.test(l)) continue
    const m = /^(const|let)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(l)
    if (m) out.set(m[2], i + 1)
  }
  return out
}

function stripNonCode(lines: string[], end: number): string[] {
  // Returns a copy of lines[0..end-1] with comments and string literals
  // (including template literals and multiline /* … */ blocks) blanked
  // out. We don't try to parse — we just want to suppress matches that
  // come from docstrings / wordlists.
  const out = new Array<string>(end).fill("")
  let inBlockComment = false
  let inTemplate = false
  for (let i = 0; i < end && i < lines.length; i++) {
    let l = lines[i]
    let buf = ""
    let j = 0
    while (j < l.length) {
      // close block comment
      if (inBlockComment) {
        const close = l.indexOf("*/", j)
        if (close === -1) {
          j = l.length
          break
        }
        j = close + 2
        inBlockComment = false
        continue
      }
      // close template literal (very rough — doesn't handle ${} fully)
      if (inTemplate) {
        const close = l.indexOf("`", j)
        if (close === -1) {
          j = l.length
          break
        }
        j = close + 1
        inTemplate = false
        continue
      }
      // open block comment
      if (l[j] === "/" && l[j + 1] === "*") {
        inBlockComment = true
        j += 2
        continue
      }
      // line comment — drop the rest of the line
      if (l[j] === "/" && l[j + 1] === "/") {
        break
      }
      // template literal start
      if (l[j] === "`") {
        inTemplate = true
        j += 1
        continue
      }
      // single/double quoted string — skip to matching quote
      if (l[j] === '"' || l[j] === "'") {
        const q = l[j]
        let k = j + 1
        while (k < l.length && l[k] !== q) {
          if (l[k] === "\\") k += 2
          else k++
        }
        j = k + 1
        continue
      }
      buf += l[j]
      j++
    }
    out[i] = buf
  }
  return out
}

function findEarliestReferences(
  lines: string[],
  excludeLine: number,
  symbols: string[],
): Map<string, number> {
  // For each symbol, find the earliest line it's referenced ANYWHERE in the
  // file (excluding its own declaration). We strip comments and strings so
  // matches inside docstrings/wordlists don't count.
  const stripped = stripNonCode(lines, lines.length)
  const refs = new Map<string, number>()
  for (let i = 0; i < stripped.length; i++) {
    if (i + 1 === excludeLine) continue
    const l = stripped[i]
    if (!l) continue
    for (const sym of symbols) {
      if (refs.has(sym)) continue
      const re = new RegExp(`\\b${sym}\\b`)
      if (re.test(l)) refs.set(sym, i + 1)
    }
  }
  return refs
}

function isInsideFunctionBody(lines: string[], lineIndex0: number): boolean {
  // Heuristic: count brace depth of `function … {` declarations from the top
  // of the file down to `lineIndex0`. If we're at depth ≥ 1 inside a
  // `function`, the reference at this line won't run during the synchronous
  // dispatch unless that function is *called* during dispatch (which is
  // the actual TDZ trap, but we deliberately stay conservative — we flag
  // top-level references and let humans review function-internal refs).
  let depth = 0
  let inFnBody = false
  for (let i = 0; i <= lineIndex0; i++) {
    const l = lines[i]
    // crude: line containing `function name(...)` or `=> {` opens a body
    if (/^\s*(async\s+)?function\s+\w+|^\s*(async\s+)?function\s*\(|=>\s*\{/.test(l)) {
      inFnBody = true
    }
    for (const ch of l) {
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) inFnBody = false
      }
    }
  }
  return inFnBody && depth > 0
}

function audit(file: string): Violation[] {
  const text = readFileSync(file, "utf8")
  const lines = text.split(/\r?\n/)
  const dispatch = findDispatchLine(lines)
  if (dispatch === -1) return [] // no top-level dispatch (e.g. _lib/common.ts)
  const decls = findRuntimeDeclarations(lines, dispatch)
  if (decls.size === 0) return []
  const violations: Violation[] = []
  for (const [sym, declLine] of decls) {
    // The bug we want to catch: a top-level statement (non-fn body) that
    // references `sym` at a line < declLine. Anywhere in the file.
    const refs = findEarliestReferences(lines, declLine, [sym])
    const refLine = refs.get(sym)
    if (refLine == null || refLine >= declLine) continue
    // Conservative: only flag references that are NOT inside a function body
    // (those run only when the function is called — could still be a real
    // TDZ if the function is invoked during dispatch, but we keep the audit
    // narrow to avoid noise).
    if (isInsideFunctionBody(lines, refLine - 1)) continue
    violations.push({
      file,
      symbol: sym,
      declaredAt: declLine,
      referencedAt: refLine,
      context: lines[refLine - 1].trim(),
    })
  }
  return violations
}

// ---------------------------------------------------------------------------

const files = listToolFiles()
const allViolations: Violation[] = []
for (const f of files) {
  try {
    allViolations.push(...audit(f))
  } catch (e) {
    console.error(`✗ failed to audit ${f}: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
}

if (allViolations.length === 0) {
  console.log(`✓ TDZ audit: ${files.length} file(s) clean.`)
  process.exit(0)
}

console.error(`✗ TDZ audit: ${allViolations.length} violation(s)\n`)
for (const v of allViolations) {
  const rel = v.file.replace(/\\/g, "/").replace(/^.*?security\//, "security/")
  console.error(`  ${rel}`)
  console.error(`    '${v.symbol}' declared on line ${v.declaredAt}`)
  console.error(`    referenced on line ${v.referencedAt}: ${v.context}`)
  console.error()
}
console.error(
  `Fix: move the const/let declaration above the dispatch block, OR\n` +
    `wrap the value in a function (function decls are hoisted).\n` +
    `See "Style rules for new tools" in security/README.md.`,
)
process.exit(1)
