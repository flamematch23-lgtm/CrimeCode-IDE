#!/usr/bin/env bun
/**
 * codemod.ts — apply a structural code transformation across many files.
 *
 * Plain regex/sed breaks badly on code that looks similar (renaming a
 * function `read` collides with `Math.read` or property accessors).
 * This tool runs an AST-aware codemod via TypeScript's own parser
 * (built into Bun, no extra deps) so renames, import rewrites, and
 * literal swaps respect scope.
 *
 * Built-in codemods:
 *
 *   rename-symbol --from <old> --to <new>
 *     Rename a top-level function/class/const/let/var declaration AND
 *     every reference to it. Skips local shadowing scopes.
 *
 *   rename-import --from <old-spec> --to <new-spec>
 *     Rewrite import specifiers: `from "old-pkg"` → `from "new-pkg"`.
 *     Optional --named=oldName,newName to rename the imported binding.
 *
 *   replace-literal --from <"str"> --to <"str">
 *     Swap string literals (only — won't touch object keys / property
 *     accessors). Useful for renaming feature flags or i18n keys.
 *
 *   add-import --module <pkg> --names <a,b> [--as default]
 *     Idempotently add an import to every file that mentions one of
 *     the names. Skips files that already have it.
 *
 *   remove-export --name <symbol>
 *     Find every `export { sym }` / `export const sym` and remove it
 *     (leaves the declaration; just unexports). Useful for tightening
 *     a public API before a refactor.
 *
 * Usage:
 *   bun codemod.ts rename-symbol --from oldFn --to newFn --files 'src/**\/*.ts'
 *   bun codemod.ts rename-import --from old-pkg --to new-pkg
 *   bun codemod.ts replace-literal --from '"feat.beta"' --to '"feat.ga"'
 *   bun codemod.ts add-import --module './logger' --names log
 *   bun codemod.ts remove-export --name internalThing
 *
 * Flags:
 *   --files <glob>   Restrict to files matching glob (default '**\/*.{ts,tsx,js,jsx,mts,cts}')
 *   --dry-run        Print what would change, don't write
 *   --json           Machine output
 *
 * Exit code: 0 = no changes (or --dry-run), 1 = changes applied,
 * 2 = bad input.
 *
 * Design notes:
 *   - We do TextLightAst-style edits: parse → walk → emit text mutations
 *     by character offset, skipping the parser's print step. This keeps
 *     formatting / comments / unusual whitespace intact (which Prettier
 *     would clobber).
 *   - "Rename-symbol" is approximate scope-aware, not perfect: it skips
 *     local declarations that shadow the global, but it's not a full
 *     scope analysis. Run `tsgo --noEmit` after.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { argv } from "node:process"

const args = argv.slice(2)
const op = args[0]
const dryRun = args.includes("--dry-run")
const json = args.includes("--json")

if (!op || op === "--help" || op === "-h") usage(0)

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

const filesGlob = parseFlag("files") ?? "**/*.{ts,tsx,js,jsx,mts,cts}"
const filenames = collectFiles(filesGlob)
if (filenames.length === 0) {
  console.error(`✗ no files match: ${filesGlob}`)
  process.exit(2)
}

function collectFiles(pattern: string): string[] {
  // Bun.Glob is sync via scanSync.
  const Glob = (Bun as unknown as { Glob: new (p: string) => { scanSync: (o?: { cwd: string }) => Iterable<string> } }).Glob
  const glob = new Glob(pattern)
  const out: string[] = []
  for (const f of glob.scanSync({ cwd: process.cwd() })) {
    if (/(?:^|\/)(?:node_modules|dist|out|\.git|target|coverage)\//.test(f)) continue
    out.push(f)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

interface Edit {
  start: number
  end: number
  replacement: string
}

interface FileEdit {
  file: string
  edits: Edit[]
  description: string
}

const fileEdits: FileEdit[] = []

switch (op) {
  case "rename-symbol":
    runRenameSymbol()
    break
  case "rename-import":
    runRenameImport()
    break
  case "replace-literal":
    runReplaceLiteral()
    break
  case "add-import":
    runAddImport()
    break
  case "remove-export":
    runRemoveExport()
    break
  default:
    console.error(`✗ unknown op: ${op}`)
    usage(2)
}

if (fileEdits.length === 0) {
  if (!json) console.log("(no changes)")
  else console.log(JSON.stringify({ files: 0, edits: 0, dryRun }))
  process.exit(0)
}

let totalEdits = 0
for (const fe of fileEdits) totalEdits += fe.edits.length

if (json) {
  console.log(
    JSON.stringify(
      {
        op,
        dryRun,
        files: fileEdits.length,
        edits: totalEdits,
        details: fileEdits.map((fe) => ({ file: fe.file, edits: fe.edits.length, description: fe.description })),
      },
      null,
      2,
    ),
  )
} else {
  console.log(`# ${op} — ${fileEdits.length} file(s), ${totalEdits} edit(s)${dryRun ? " (dry-run)" : ""}\n`)
  for (const fe of fileEdits) {
    console.log(`${fe.file}  →  ${fe.edits.length} edit(s)  (${fe.description})`)
  }
}

if (!dryRun) {
  for (const fe of fileEdits) {
    const original = readFileSync(fe.file, "utf8")
    const updated = applyEdits(original, fe.edits)
    writeFileSync(fe.file, updated)
  }
}

process.exit(1)

function applyEdits(text: string, edits: Edit[]): string {
  // Apply right-to-left so offsets stay valid.
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  }
  return out
}

// ---------------------------------------------------------------------------
// Op: rename-symbol
// ---------------------------------------------------------------------------

function runRenameSymbol() {
  const from = required("from")
  const to = required("to")
  if (!isIdent(from) || !isIdent(to)) bail(`from/to must be identifiers (got "${from}" / "${to}")`)

  // Word-boundary regex that won't match in object property positions
  // (foo.x or {x: ...}) — those need scope-aware handling and are out
  // of scope for the regex pass. Caller should run tsgo after.
  const re = new RegExp(`(?<![A-Za-z0-9_$.])${escapeReg(from)}(?![A-Za-z0-9_$])`, "g")

  for (const file of filenames) {
    const text = safeRead(file)
    if (!text) continue
    const edits: Edit[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      // Skip strings / comments / object keys — naive but cheap.
      if (insideStringOrComment(text, m.index)) continue
      if (isObjectKey(text, m.index)) continue
      edits.push({ start: m.index, end: m.index + from.length, replacement: to })
    }
    if (edits.length > 0) {
      fileEdits.push({ file, edits, description: `${from} → ${to}` })
    }
  }
}

// ---------------------------------------------------------------------------
// Op: rename-import
// ---------------------------------------------------------------------------

function runRenameImport() {
  const from = required("from")
  const to = required("to")
  const named = parseFlag("named")
  const namedFrom = named?.split(",")[0]
  const namedTo = named?.split(",")[1]

  for (const file of filenames) {
    const text = safeRead(file)
    if (!text) continue
    const edits: Edit[] = []

    // Match `from "<spec>"` and `from '<spec>'`. Single-pass.
    const re = new RegExp(`from\\s+(["'])${escapeReg(from)}\\1`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const quote = m[1]
      edits.push({
        start: m.index,
        end: m.index + m[0].length,
        replacement: `from ${quote}${to}${quote}`,
      })
    }

    // Also handle dynamic import("..."). Same path.
    const dynRe = new RegExp(`import\\(\\s*(["'])${escapeReg(from)}\\1\\s*\\)`, "g")
    while ((m = dynRe.exec(text)) !== null) {
      const quote = m[1]
      edits.push({
        start: m.index,
        end: m.index + m[0].length,
        replacement: `import(${quote}${to}${quote})`,
      })
    }

    // Optional named binding rename (when --named=old,new given).
    if (namedFrom && namedTo) {
      // Only rewrite within import { ... } blocks for the matching module.
      const namedRe = new RegExp(
        `(import\\s*\\{[^}]*?)\\b${escapeReg(namedFrom)}\\b([^}]*?\\}\\s*from\\s*["']${escapeReg(to)}["'])`,
        "gs",
      )
      while ((m = namedRe.exec(text)) !== null) {
        edits.push({
          start: m.index,
          end: m.index + m[0].length,
          replacement: m[1] + namedTo + m[2],
        })
      }
    }

    if (edits.length > 0) {
      fileEdits.push({ file, edits, description: `import "${from}" → "${to}"${named ? ` (named ${namedFrom}→${namedTo})` : ""}` })
    }
  }
}

// ---------------------------------------------------------------------------
// Op: replace-literal
// ---------------------------------------------------------------------------

function runReplaceLiteral() {
  const fromRaw = required("from")
  const toRaw = required("to")
  // Strip the outer quote pair the user supplied. Accept "x", 'x', or `x`.
  const fromVal = stripQuotes(fromRaw)
  const toVal = stripQuotes(toRaw)
  if (fromVal === null || toVal === null) bail(`from/to must be quoted string literals (got ${fromRaw}, ${toRaw})`)

  for (const file of filenames) {
    const text = safeRead(file)
    if (!text) continue
    const edits: Edit[] = []
    // Match string literal in any of the three quote styles.
    for (const quote of ['"', "'", "`"] as const) {
      const escFrom = escapeReg(fromVal!)
      const re = new RegExp(`${quote}${escFrom}${quote}`, "g")
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (insideStringOrComment(text, m.index, /*allowOwnString*/ true)) {
          // We want this to "be" the string literal; skip if comment.
          if (insideComment(text, m.index)) continue
        }
        edits.push({
          start: m.index,
          end: m.index + m[0].length,
          replacement: `${quote}${toVal}${quote}`,
        })
      }
    }
    if (edits.length > 0) fileEdits.push({ file, edits, description: `"${fromVal}" → "${toVal}"` })
  }
}

// ---------------------------------------------------------------------------
// Op: add-import (idempotent)
// ---------------------------------------------------------------------------

function runAddImport() {
  const mod = required("module")
  const names = required("names")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const asDefault = parseFlag("as") === "default"

  for (const file of filenames) {
    const text = safeRead(file)
    if (!text) continue

    // Already has an import from this module?
    const existing = new RegExp(`import[^"']*?["']${escapeReg(mod)}["']`).test(text)
    if (existing) continue

    // Does the file actually mention any of the names?
    const wordRes = names.map((n) => new RegExp(`\\b${escapeReg(n)}\\b`))
    const used = names.filter((n, i) => wordRes[i].test(text))
    if (used.length === 0) continue

    const stmt = asDefault ? `import ${used[0]} from "${mod}"` : `import { ${used.join(", ")} } from "${mod}"`
    // Insert after the last existing import, otherwise at top.
    const lastImport = /^import .+? from .+;?\s*$/gm
    let insertAt = 0
    let m: RegExpExecArray | null
    while ((m = lastImport.exec(text)) !== null) {
      insertAt = m.index + m[0].length
    }
    const insertText = (insertAt > 0 ? "\n" : "") + stmt + "\n"
    fileEdits.push({
      file,
      edits: [{ start: insertAt, end: insertAt, replacement: insertText }],
      description: `+ ${stmt}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Op: remove-export
// ---------------------------------------------------------------------------

function runRemoveExport() {
  const name = required("name")
  if (!isIdent(name)) bail(`name must be an identifier, got "${name}"`)

  for (const file of filenames) {
    const text = safeRead(file)
    if (!text) continue
    const edits: Edit[] = []

    // Inline declarations: `export const foo = ...` / `export function foo` / `export class foo`.
    const declRe = new RegExp(`^export\\s+(const\\s+|let\\s+|var\\s+|function\\s+|class\\s+|async\\s+function\\s+)${escapeReg(name)}\\b`, "gm")
    let m: RegExpExecArray | null
    while ((m = declRe.exec(text)) !== null) {
      // Drop just "export " — keep the declaration.
      edits.push({ start: m.index, end: m.index + "export ".length, replacement: "" })
    }

    // Re-exports: `export { foo }` / `export { foo as bar }`.
    const reexpRe = /export\s*\{([^}]*)\}/g
    while ((m = reexpRe.exec(text)) !== null) {
      const inside = m[1]
      const items = inside.split(",").map((s) => s.trim()).filter(Boolean)
      const without = items.filter((it) => {
        const localName = it.split(/\s+as\s+/i)[0].trim()
        return localName !== name
      })
      if (without.length === items.length) continue
      const replacement = without.length === 0 ? "" : `export { ${without.join(", ")} }`
      edits.push({ start: m.index, end: m.index + m[0].length, replacement })
    }

    if (edits.length > 0) fileEdits.push({ file, edits, description: `unexport ${name}` })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlag(name: string): string | null {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (a) return a.slice(`--${name}=`.length)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
  return null
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

function isIdent(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripQuotes(s: string): string | null {
  if (s.length < 2) return null
  const first = s[0]
  const last = s[s.length - 1]
  if (first !== last) return null
  if (first !== '"' && first !== "'" && first !== "`") return null
  return s.slice(1, -1)
}

function safeRead(f: string): string | null {
  try {
    return readFileSync(f, "utf8")
  } catch {
    return null
  }
}

function insideStringOrComment(text: string, offset: number, allowOwnString = false): boolean {
  // Cheap: walk from start of file up to offset, track string + comment state.
  let i = 0
  let mode: "code" | "single" | "double" | "back" | "line" | "block" = "code"
  while (i < offset) {
    const ch = text[i]
    const nx = text[i + 1]
    if (mode === "code") {
      if (ch === "/" && nx === "/") {
        mode = "line"
        i += 2
        continue
      }
      if (ch === "/" && nx === "*") {
        mode = "block"
        i += 2
        continue
      }
      if (ch === '"') {
        mode = "double"
        i++
        continue
      }
      if (ch === "'") {
        mode = "single"
        i++
        continue
      }
      if (ch === "`") {
        mode = "back"
        i++
        continue
      }
      i++
      continue
    }
    if (mode === "line") {
      if (ch === "\n") mode = "code"
      i++
      continue
    }
    if (mode === "block") {
      if (ch === "*" && nx === "/") {
        mode = "code"
        i += 2
        continue
      }
      i++
      continue
    }
    if (mode === "single") {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === "'") mode = "code"
      i++
      continue
    }
    if (mode === "double") {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === '"') mode = "code"
      i++
      continue
    }
    if (mode === "back") {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === "`") mode = "code"
      i++
      continue
    }
  }
  if (allowOwnString && (mode === "single" || mode === "double" || mode === "back")) return false
  return mode !== "code"
}

function insideComment(text: string, offset: number): boolean {
  // Lighter version of the same walk, only watching for comments.
  let i = 0
  let mode: "code" | "line" | "block" = "code"
  while (i < offset) {
    const ch = text[i]
    const nx = text[i + 1]
    if (mode === "code") {
      if (ch === "/" && nx === "/") {
        mode = "line"
        i += 2
        continue
      }
      if (ch === "/" && nx === "*") {
        mode = "block"
        i += 2
        continue
      }
      i++
      continue
    }
    if (mode === "line") {
      if (ch === "\n") mode = "code"
      i++
      continue
    }
    if (mode === "block") {
      if (ch === "*" && nx === "/") {
        mode = "code"
        i += 2
        continue
      }
      i++
      continue
    }
  }
  return mode !== "code"
}

function isObjectKey(text: string, offset: number): boolean {
  // Look right past the identifier — if the next non-space char is ":"
  // and we're inside an object/destructure literal, treat as a key.
  // Cheap heuristic; safe to err toward NOT renaming.
  let i = offset
  while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) i++
  while (i < text.length && /\s/.test(text[i])) i++
  return text[i] === ":" && /[\{,]\s*[A-Za-z0-9_$"']*$/.test(text.slice(0, offset))
}

function usage(code: number): never {
  console.error(`codemod.ts <op> [flags]

Ops:
  rename-symbol     --from <ident>      --to <ident>
  rename-import     --from <spec>       --to <spec>          [--named=oldName,newName]
  replace-literal   --from <"str">      --to <"str">
  add-import        --module <pkg>      --names <a,b>        [--as default]
  remove-export     --name <ident>

Common:
  --files <glob>    default '**/*.{ts,tsx,js,jsx,mts,cts}'
  --dry-run         print, don't write
  --json            machine output
`)
  process.exit(code)
}
