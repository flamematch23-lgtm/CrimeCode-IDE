#!/usr/bin/env bun
/**
 * api-shape-extract.ts — emit a flat list of every public API export
 * in a TS package.
 *
 * Why: when you're about to refactor a package, you need to know what
 * an external consumer sees. When you're reviewing a PR, you need to
 * spot accidental API additions / removals. When you're upgrading a
 * dependency you maintain, the diff between old/new shape is the
 * single most important review artefact. This tool produces that
 * shape in seconds, without going through `tsgo --emit`.
 *
 * What we emit per export (ordered by file path then symbol name):
 *
 *   <file>:<line>  EXPORT  <kind>  <name>  [<signature>]
 *
 * Kinds: function, class, const, type, interface, enum, namespace, default.
 *
 * Signatures: extracted from the declaration verbatim, single-line-collapsed.
 * For functions/classes: arg list + return type. For types/interfaces: the
 * type alias / interface body collapsed.
 *
 * Usage:
 *   bun api-shape-extract.ts                              # current package
 *   bun api-shape-extract.ts --pkg packages/opencode      # specific package
 *   bun api-shape-extract.ts --json
 *   bun api-shape-extract.ts --diff <other-shape.txt>     # diff vs a previously-saved snapshot
 *   bun api-shape-extract.ts --entry src/index.ts         # follow a specific entry
 *
 * Common workflow:
 *   bun api-shape-extract.ts > /tmp/api-before.txt   # before refactor
 *   ... refactor ...
 *   bun api-shape-extract.ts --diff /tmp/api-before.txt
 *   # → list of additions/removals/signature changes; review each one.
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname, isAbsolute, join } from "node:path"
import { argv } from "node:process"

interface ExportRow {
  file: string
  line: number
  kind: string
  name: string
  signature: string
}

const args = argv.slice(2)
const json = args.includes("--json")
const pkgDir = parseFlag("pkg") ?? process.cwd()
const entryArg = parseFlag("entry")
const diffPath = parseFlag("diff")

// Resolve package root and entry file.
let entry: string
if (entryArg) {
  entry = isAbsolute(entryArg) ? entryArg : join(pkgDir, entryArg)
} else {
  entry = pickEntry(pkgDir)
}
if (!existsSync(entry)) {
  console.error(`✗ entry file not found: ${entry}`)
  process.exit(2)
}

const exports = collectExports(entry, new Set())
exports.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))

if (diffPath) {
  if (!existsSync(diffPath)) {
    console.error(`✗ diff baseline not found: ${diffPath}`)
    process.exit(2)
  }
  const baseline = parseShapeFile(readFileSync(diffPath, "utf8"))
  printDiff(baseline, exports)
  process.exit(0)
}

if (json) {
  console.log(JSON.stringify(exports, null, 2))
} else {
  console.log(`# API shape — ${entry} — ${exports.length} export(s)\n`)
  for (const e of exports) {
    console.log(`${e.file}:${e.line}  EXPORT  ${e.kind}  ${e.name}  ${e.signature}`)
  }
}

// ---------------------------------------------------------------------------
// Entry / package detection
// ---------------------------------------------------------------------------

function pickEntry(dir: string): string {
  // Prefer package.json `exports` → main → src/index.ts → index.ts.
  const pjPath = join(dir, "package.json")
  if (existsSync(pjPath)) {
    const pj = JSON.parse(readFileSync(pjPath, "utf8")) as {
      main?: string
      module?: string
      types?: string
      exports?: unknown
    }
    if (typeof pj.types === "string") return resolve(dir, pj.types)
    if (typeof pj.module === "string") return resolveSourceFor(dir, pj.module)
    if (typeof pj.main === "string") return resolveSourceFor(dir, pj.main)
  }
  for (const c of ["src/index.ts", "src/index.tsx", "index.ts", "index.tsx"]) {
    const p = resolve(dir, c)
    if (existsSync(p)) return p
  }
  return resolve(dir, "src/index.ts")
}

function resolveSourceFor(dir: string, jsPath: string): string {
  // Prefer the .ts source over the .js compiled. Most monorepos compile
  // to dist/ but want shape-extract on src/.
  const noExt = jsPath.replace(/\.[mc]?[tj]sx?$/, "")
  const candidates = [
    noExt.replace(/^dist\//, "src/") + ".ts",
    noExt.replace(/^dist\//, "src/") + ".tsx",
    noExt + ".ts",
    noExt + ".tsx",
    jsPath,
  ]
  for (const c of candidates) {
    const full = resolve(dir, c)
    if (existsSync(full)) return full
  }
  return resolve(dir, jsPath)
}

// ---------------------------------------------------------------------------
// Export extraction
//
// We do regex-based parsing rather than spinning up the TypeScript compiler
// API, on the same grounds as find-symbol.ts: 80% of value at 5% of code,
// good enough for review-time API shape.
// ---------------------------------------------------------------------------

function collectExports(file: string, seen: Set<string>): ExportRow[] {
  if (seen.has(file)) return []
  seen.add(file)
  const text = safeRead(file)
  if (!text) return []
  const out: ExportRow[] = []
  const lines = text.split("\n")

  // Direct declarations: export const / function / class / interface / type / enum / namespace.
  const declRe =
    /^export\s+(default\s+)?(?:async\s+)?(const|let|var|function\s*\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = declRe.exec(line)
    if (m) {
      const kind = m[2].split(/\s+/)[0]
      const name = m[3]
      const sig = extractSignature(text, lines, i, kind, name)
      out.push({ file: relPath(file), line: i + 1, kind, name, signature: sig })
      continue
    }

    // export default <expr>
    const def = /^export\s+default\s+(.+)$/.exec(line)
    if (def && !declRe.test(line)) {
      out.push({
        file: relPath(file),
        line: i + 1,
        kind: "default",
        name: "(default)",
        signature: def[1].trim().slice(0, 200),
      })
      continue
    }

    // export { a, b as c }  or  export { a } from "x"
    const blk = /^export\s*\{([^}]+)\}\s*(?:from\s*["']([^"']+)["'])?/.exec(line)
    if (blk) {
      const reExportFrom = blk[2]
      for (const item of blk[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const parts = item.split(/\s+as\s+/i).map((s) => s.trim())
        const exposed = parts[1] ?? parts[0]
        out.push({
          file: relPath(file),
          line: i + 1,
          kind: reExportFrom ? `re-export from "${reExportFrom}"` : "re-export",
          name: exposed,
          signature: reExportFrom ? `from "${reExportFrom}"` : "(local)",
        })
      }
    }

    // export * from "..."  or  export * as ns from "..."
    const star = /^export\s+\*(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s+from\s*["']([^"']+)["']/.exec(line)
    if (star) {
      out.push({
        file: relPath(file),
        line: i + 1,
        kind: star[1] ? "namespace re-export" : "barrel re-export",
        name: star[1] ?? "*",
        signature: `from "${star[2]}"`,
      })
      // Follow the barrel transitively, but only within this package.
      const target = resolveModule(file, star[2])
      if (target) out.push(...collectExports(target, seen))
    }
  }

  return out
}

function extractSignature(text: string, lines: string[], lineIdx: number, kind: string, name: string): string {
  // For functions / classes: capture from the opening `(` (or `<` for
  // generics) up to the matching `)` plus return type up to `{` or `;`.
  const startLine = lines[lineIdx]
  if (kind === "function" || kind === "function*") {
    const startInLine = startLine.indexOf(name) + name.length
    const tail = text.slice(textOffsetFromLine(text, lineIdx) + startInLine)
    const sig = tail.match(/^(\s*<[^>]*>)?\s*(\([\s\S]*?\))(\s*:[^{;\n]+)?/)
    if (sig) return collapseWhitespace(sig[0])
    return collapseWhitespace(tail.slice(0, 120))
  }
  if (kind === "class") {
    const tail = text.slice(textOffsetFromLine(text, lineIdx) + startLine.indexOf(name))
    const sig = tail.match(/^[A-Za-z_$][A-Za-z0-9_$<>,\s]*?(?=\s*\{)/)
    return collapseWhitespace(sig?.[0] ?? `class ${name}`)
  }
  if (kind === "interface") {
    const startOff = textOffsetFromLine(text, lineIdx)
    const open = text.indexOf("{", startOff)
    const close = matchingBrace(text, open)
    if (close > 0) {
      return collapseWhitespace(text.slice(open, close + 1)).slice(0, 240)
    }
    return `interface ${name}`
  }
  if (kind === "type") {
    const tail = text.slice(textOffsetFromLine(text, lineIdx))
    const sig = tail.match(/^export\s+type\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(<[^>]*>)?\s*=([\s\S]*?)(?=\n\s*$|;\n|\n[A-Za-z]|^export\b|$)/m)
    if (sig) return collapseWhitespace("=" + sig[2]).slice(0, 240)
    return `type ${name}`
  }
  if (kind === "const" || kind === "let" || kind === "var") {
    const tail = text.slice(textOffsetFromLine(text, lineIdx))
    const sig = /^export\s+(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(?::([^=\n]+))?\s*=\s*(.+?)(?:;|$)/m.exec(tail)
    if (sig) {
      const tyAnno = (sig[1] ?? "").trim()
      const valStart = (sig[2] ?? "").trim().slice(0, 80)
      return tyAnno ? `: ${tyAnno} = ${valStart}` : `= ${valStart}`
    }
  }
  if (kind === "enum") return `enum ${name}`
  if (kind === "namespace") return `namespace ${name}`
  return ""
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function textOffsetFromLine(text: string, lineIdx: number): number {
  let off = 0
  let cur = 0
  while (cur < lineIdx) {
    const nl = text.indexOf("\n", off)
    if (nl < 0) break
    off = nl + 1
    cur++
  }
  return off
}

function matchingBrace(text: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function resolveModule(fromFile: string, spec: string): string | null {
  // Only resolve relative imports; we don't follow node_modules.
  if (!spec.startsWith(".")) return null
  const base = resolve(dirname(fromFile), spec)
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(base + ext)) return base + ext
  }
  return null
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function relPath(p: string): string {
  const cwd = process.cwd()
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1).replace(/\\/g, "/")
  return p
}

function parseFlag(name: string): string | null {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (a) return a.slice(`--${name}=`.length)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
  return null
}

// ---------------------------------------------------------------------------
// Diff mode
// ---------------------------------------------------------------------------

function parseShapeFile(text: string): ExportRow[] {
  const out: ExportRow[] = []
  // Match: <file>:<line>  EXPORT  <kind>  <name>  [<signature>]
  const re = /^(\S+):(\d+)\s+EXPORT\s+(\S+)\s+(\S+)\s+(.*)$/
  for (const line of text.split("\n")) {
    const m = re.exec(line)
    if (!m) continue
    out.push({ file: m[1], line: Number(m[2]), kind: m[3], name: m[4], signature: m[5] })
  }
  return out
}

function printDiff(before: ExportRow[], after: ExportRow[]) {
  const beforeMap = new Map(before.map((e) => [e.name + "@" + e.kind, e] as const))
  const afterMap = new Map(after.map((e) => [e.name + "@" + e.kind, e] as const))

  const removed: ExportRow[] = []
  const added: ExportRow[] = []
  const changed: Array<{ before: ExportRow; after: ExportRow }> = []

  for (const [k, b] of beforeMap) {
    const a = afterMap.get(k)
    if (!a) {
      removed.push(b)
      continue
    }
    if (a.signature !== b.signature) changed.push({ before: b, after: a })
  }
  for (const [k, a] of afterMap) {
    if (!beforeMap.has(k)) added.push(a)
  }

  console.log(`# API diff — ${added.length} added, ${removed.length} removed, ${changed.length} changed`)

  if (added.length > 0) {
    console.log(`\n## ➕ Added (${added.length})`)
    for (const e of added) console.log(`+ ${e.kind} ${e.name}  ${e.signature}  (${e.file}:${e.line})`)
  }
  if (removed.length > 0) {
    console.log(`\n## ➖ Removed (${removed.length})  ⚠️ likely breaking`)
    for (const e of removed) console.log(`- ${e.kind} ${e.name}  ${e.signature}  (${e.file}:${e.line})`)
  }
  if (changed.length > 0) {
    console.log(`\n## ✏️ Signature changed (${changed.length})  ⚠️ may be breaking`)
    for (const c of changed) {
      console.log(`~ ${c.before.kind} ${c.before.name}`)
      console.log(`    before: ${c.before.signature}`)
      console.log(`    after:  ${c.after.signature}`)
    }
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log(`\n✅ No API changes detected.`)
  }
}
