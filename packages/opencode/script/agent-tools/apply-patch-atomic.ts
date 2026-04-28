#!/usr/bin/env bun
/**
 * Apply a unified diff to the working tree atomically: either every hunk
 * lands or none of them do. Useful when an agent is about to make a
 * multi-file refactor and a half-applied state would leave the repo
 * broken.
 *
 * Strategy:
 *   1. dry-run via `git apply --check` — fail fast if the diff doesn't
 *      apply cleanly.
 *   2. snapshot the working tree via `git stash --keep-index --include-untracked`
 *      so we can roll back if anything goes wrong.
 *   3. apply via `git apply --whitespace=nowarn`.
 *   4. typecheck the affected packages (if --typecheck).
 *   5. on any failure, restore the snapshot.
 *
 * Usage:
 *   bun script/agent-tools/apply-patch-atomic.ts < my.diff
 *   bun script/agent-tools/apply-patch-atomic.ts my.diff
 *   bun script/agent-tools/apply-patch-atomic.ts --dry-run < my.diff   # only `git apply --check`
 *   bun script/agent-tools/apply-patch-atomic.ts --typecheck < my.diff  # also runs `bun run typecheck` after applying
 */

import { execFileSync, spawnSync } from "node:child_process"
import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const wantTypecheck = args.includes("--typecheck")
const positional = args.filter((a) => !a.startsWith("--"))

async function getDiff(): Promise<string> {
  if (positional[0]) return await Bun.file(positional[0]).text()
  // stdin — see token-budget-estimate.ts for the reader-based pattern.
  const reader = Bun.stdin.stream().getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const diff = (await getDiff()).trim()
if (!diff) {
  console.error("apply-patch-atomic: empty diff on stdin")
  process.exit(2)
}

// Write to a temp file so git apply has something stable to read.
const patchPath = path.join(tmpdir(), `agent-patch-${Date.now()}-${process.pid}.diff`)
writeFileSync(patchPath, diff + "\n", "utf8")

function git(...args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { encoding: "utf8" })
  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status ?? 1,
  }
}

function fatal(msg: string, ...rest: string[]): never {
  console.error("✗ " + msg)
  for (const r of rest) console.error("  " + r)
  try {
    unlinkSync(patchPath)
  } catch {}
  process.exit(1)
}

// 1. Dry-run check.
{
  const r = git("apply", "--check", "--whitespace=nowarn", patchPath)
  if (r.status !== 0) fatal("git apply --check failed — patch does not apply cleanly", r.stderr)
}

if (dryRun) {
  console.log("✓ Dry-run passed — patch applies cleanly. No changes written.")
  unlinkSync(patchPath)
  process.exit(0)
}

// 2. Snapshot. Stash uncommitted changes so we can rewind to a known
// state if the apply or post-checks fail. Use `--include-untracked` so
// new files we haven't added are saved too.
let stashed = false
{
  const status = git("status", "--porcelain")
  if (status.stdout) {
    const r = git("stash", "push", "--keep-index", "--include-untracked", "-m", "agent-tools/apply-patch-atomic")
    if (r.status !== 0) fatal("git stash failed", r.stderr)
    stashed = true
  }
}

function rollback(reason: string): never {
  console.error("✗ " + reason + " — rolling back …")
  // Reset whatever was applied.
  git("apply", "-R", "--whitespace=nowarn", patchPath)
  if (stashed) {
    const r = git("stash", "pop")
    if (r.status !== 0) console.error("  stash pop failed: " + r.stderr + " — please inspect manually")
  }
  try {
    unlinkSync(patchPath)
  } catch {}
  process.exit(1)
}

// 3. Apply.
{
  const r = git("apply", "--whitespace=nowarn", patchPath)
  if (r.status !== 0) rollback("git apply failed: " + r.stderr)
}

console.log("✓ Patch applied")

// 4. Optional typecheck.
if (wantTypecheck) {
  console.log("→ running bun run typecheck …")
  try {
    execFileSync("bun", ["run", "typecheck"], { stdio: "inherit" })
  } catch {
    rollback("typecheck failed after apply")
  }
  console.log("✓ Typecheck clean")
}

// 5. Commit-ready: cleanup.
try {
  unlinkSync(patchPath)
} catch {}
console.log("✓ Done. Use `git status` to inspect, or `git stash pop` if you also stashed pre-existing changes.")
