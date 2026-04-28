#!/usr/bin/env bun
/**
 * Symbol-aware search across a TypeScript / JavaScript codebase. Tries
 * to mimic the ergonomics of an IDE's "go to definition" / "find all
 * references" without spinning up a full LSP — uses ripgrep + a small
 * AST-flavoured regex set.
 *
 * Usage:
 *   bun script/agent-tools/find-symbol.ts def    revokeSession
 *   bun script/agent-tools/find-symbol.ts refs   revokeSession
 *   bun script/agent-tools/find-symbol.ts both   revokeSession
 *
 * `def` looks for definitions (function, class, const, let, var, type,
 * interface, enum, export). `refs` looks for usages anywhere — minus
 * the line that's also a definition match.
 *
 * Limitations:
 *   - String-shadowing isn't detected (a variable named the same in
 *     another scope will be found too). For tight precision use a real
 *     LSP. For 90% of "where is this used" questions this is enough.
 */

import { execFileSync } from "node:child_process"

const args = process.argv.slice(2)
const mode = args[0] as "def" | "refs" | "both" | undefined
const symbol = args[1]

if (!mode || !symbol || !["def", "refs", "both"].includes(mode)) {
  console.error("usage: find-symbol.ts <def|refs|both> <symbol>")
  process.exit(2)
}

function rg(pattern: string): string[] {
  try {
    // ripgrep's built-in `ts` type matches *.ts but NOT *.tsx — we add .tsx
    // (and .mts/.cts for completeness) via a custom --type-add definition,
    // because passing `--type tsx` directly errors with "unrecognized file
    // type". This mirrors what `rg --type-list` shows: tsx isn't built in.
    const out = execFileSync(
      "rg",
      [
        "--no-heading",
        "--with-filename",
        "--line-number",
        "--type-add",
        "tsall:*.{ts,tsx,mts,cts}",
        "--type",
        "tsall",
        "-e",
        pattern,
      ],
      { encoding: "utf8" },
    )
    return out.split("\n").filter(Boolean)
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status === 1) return [] // no matches
    throw e
  }
}

const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Definition patterns: things that introduce a symbol.
const defPatterns = [
  // function declaration / generator / async function
  `\\b(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${escaped}\\b`,
  // class
  `\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`,
  // const / let / var
  `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`,
  // type alias / interface / enum
  `\\b(?:export\\s+)?(?:type|interface|enum)\\s+${escaped}\\b`,
  // method shorthand inside a class / object: `name(...)` or `name = ...`
  `^\\s+${escaped}\\s*[(=:]`,
  // namespace / module
  `\\b(?:export\\s+)?namespace\\s+${escaped}\\b`,
]

const defs = new Set<string>()
for (const p of defPatterns) for (const line of rg(p)) defs.add(line)

let refs: Set<string> = new Set()
if (mode !== "def") {
  // Word-boundary match for the bare symbol, anywhere.
  for (const line of rg(`\\b${escaped}\\b`)) refs.add(line)
  // Subtract definitions to leave usages.
  for (const d of defs) refs.delete(d)
}

if (mode === "def" || mode === "both") {
  console.log(`# Definitions of \`${symbol}\` (${defs.size})`)
  for (const d of [...defs].sort()) console.log("  " + d)
}
if ((mode === "refs" || mode === "both") && defs.size + refs.size > 0) {
  if (mode === "both") console.log("")
  console.log(`# References to \`${symbol}\` (${refs.size}, definitions excluded)`)
  for (const r of [...refs].sort()) console.log("  " + r)
}
if (defs.size === 0 && refs.size === 0) {
  console.log(`# No matches for \`${symbol}\``)
  process.exit(1)
}
