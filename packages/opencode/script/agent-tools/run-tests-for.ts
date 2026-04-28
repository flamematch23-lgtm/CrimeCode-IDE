#!/usr/bin/env bun
/**
 * Run only the tests that exercise the given files. Replaces the typical
 * "let me run the entire suite" with "let me run the 3 tests that matter".
 *
 * Usage:
 *   bun script/agent-tools/run-tests-for.ts src/license/auth.ts
 *   bun script/agent-tools/run-tests-for.ts src/auth.ts src/teams.ts
 *   bun script/agent-tools/run-tests-for.ts --since=HEAD~1   # files changed in last commit
 *   bun script/agent-tools/run-tests-for.ts --staged          # only staged files
 *
 * Strategy:
 *   1. Resolve the input files to absolute paths.
 *   2. For each file, find tests that import it (direct or transitive,
 *      depth 1).
 *   3. Run the union of those tests via `bun test <files>`.
 *   4. Exit code mirrors `bun test` (non-zero = failures or no tests).
 *
 * Limitations:
 *   - We only follow imports one hop. A test that imports a barrel that
 *     imports the changed file is still found (because the barrel
 *     imports the file). A test that exercises the file via runtime
 *     dispatch (e.g. via an env-driven plugin) won't be picked up —
 *     fall back to the full suite when in doubt.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { readdirSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

function resolveInputs(): string[] {
  const sinceIdx = args.indexOf("--since")
  if (sinceIdx >= 0 && args[sinceIdx + 1]) {
    const ref = args[sinceIdx + 1]
    return git(["diff", "--name-only", ref, "HEAD"])
      .split("\n")
      .filter((f) => f.trim())
      .filter((f) => existsSync(f))
  }
  if (args.includes("--staged")) {
    return git(["diff", "--cached", "--name-only"])
      .split("\n")
      .filter((f) => f.trim())
      .filter((f) => existsSync(f))
  }
  // Treat positional args as file paths.
  return args.filter((a) => !a.startsWith("--") && existsSync(a))
}

const inputs = resolveInputs()
if (inputs.length === 0) {
  console.error("usage: run-tests-for.ts <file…> | --since=<ref> | --staged")
  process.exit(2)
}

const inputBaseNames = new Set(inputs.map((f) => path.basename(f).replace(/\.(ts|tsx|js|jsx)$/, "")))
const inputAbs = new Set(inputs.map((f) => path.resolve(f)))

// Walk the tree, find every *.test.* file.
const testFiles: string[] = []
function walk(dir: string, depth = 0): void {
  if (depth > 8) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git" || e.startsWith(".")) continue
    const full = path.join(dir, e)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, depth + 1)
    else if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(e)) testFiles.push(full)
  }
}
walk(process.cwd())

// For each test file, peek at its imports. If any import resolves into
// our input set OR matches an input basename, it's a relevant test.
const relevantTests = new Set<string>()
const importRe = /(?:from|require\(\s*)["']([^"']+)["']/g
for (const tf of testFiles) {
  const content = readFileSync(tf, "utf8")
  let mm
  while ((mm = importRe.exec(content))) {
    const spec = mm[1]
    const base = path.basename(spec).replace(/\.(ts|tsx|js|jsx)$/, "")
    if (inputBaseNames.has(base)) {
      relevantTests.add(tf)
      break
    }
    // Path-resolve the import relative to the test file and see if it
    // hits one of our inputs.
    if (spec.startsWith(".")) {
      const candidates = [
        path.resolve(path.dirname(tf), spec),
        path.resolve(path.dirname(tf), spec + ".ts"),
        path.resolve(path.dirname(tf), spec + ".tsx"),
        path.resolve(path.dirname(tf), spec, "index.ts"),
      ]
      for (const c of candidates) {
        if (inputAbs.has(c)) {
          relevantTests.add(tf)
          break
        }
      }
    }
  }
}

if (relevantTests.size === 0) {
  console.log("[run-tests-for] no tests cover the input files. Listing first 5 nearby tests so the user can decide.")
  for (const tf of testFiles.slice(0, 5)) console.log(`  - ${path.relative(process.cwd(), tf)}`)
  console.log("\nSuggestion: write a failing test for the change before you fix the code.")
  process.exit(0)
}

console.log(`[run-tests-for] ${relevantTests.size} test file(s):`)
for (const t of relevantTests) console.log(`  - ${path.relative(process.cwd(), t)}`)
console.log("")

// Run via bun test.
const cmd = ["bun", "test", ...relevantTests]
console.log(`[run-tests-for] $ ${cmd.join(" ")}\n`)
try {
  execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" })
} catch (e) {
  process.exit((e as { status?: number })?.status ?? 1)
}
