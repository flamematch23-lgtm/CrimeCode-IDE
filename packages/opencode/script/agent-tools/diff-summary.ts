#!/usr/bin/env bun
/**
 * Produce a single-page summary of "what's changed in this branch".
 * Useful at the end of a long session to brief the user (or a
 * verification sub-agent) without having to re-read every diff.
 *
 * Usage:
 *   bun script/agent-tools/diff-summary.ts                # vs origin/master
 *   bun script/agent-tools/diff-summary.ts --base HEAD~3
 *   bun script/agent-tools/diff-summary.ts --staged       # only staged
 *   bun script/agent-tools/diff-summary.ts --json         # machine output
 */

import { execFileSync } from "node:child_process"

const args = process.argv.slice(2)
const wantsJson = args.includes("--json")
const base = (() => {
  const i = args.indexOf("--base")
  if (i >= 0 && args[i + 1]) return args[i + 1]
  return null
})()
const staged = args.includes("--staged")

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

interface Summary {
  base: string
  files: { path: string; insertions: number; deletions: number; status: string }[]
  totalIns: number
  totalDel: number
  newFiles: string[]
  deletedFiles: string[]
  untracked: string[]
  todos: string[]
  consoleLogs: string[]
  secrets: string[]
}

const baseRef = staged ? "" : (base ?? (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || "origin/master"))
const args2 = staged
  ? ["diff", "--cached", "--numstat"]
  : baseRef
    ? ["diff", "--numstat", `${baseRef}...HEAD`]
    : ["diff", "--numstat", "HEAD"]
const numstat = git(args2)

const files: Summary["files"] = []
let totalIns = 0
let totalDel = 0
for (const line of numstat.split("\n")) {
  if (!line.trim()) continue
  const [insStr, delStr, ...rest] = line.split("\t")
  const ins = Number.parseInt(insStr, 10) || 0
  const del = Number.parseInt(delStr, 10) || 0
  totalIns += ins
  totalDel += del
  files.push({ path: rest.join("\t"), insertions: ins, deletions: del, status: "M" })
}

const args3 = staged
  ? ["diff", "--cached", "--name-status"]
  : baseRef
    ? ["diff", "--name-status", `${baseRef}...HEAD`]
    : ["diff", "--name-status", "HEAD"]
const status = git(args3)
const newFiles: string[] = []
const deletedFiles: string[] = []
for (const line of status.split("\n")) {
  const m = line.match(/^([AMDR]\d*)\s+(.+)$/)
  if (!m) continue
  if (m[1].startsWith("A")) newFiles.push(m[2])
  if (m[1].startsWith("D")) deletedFiles.push(m[2])
  const f = files.find((x) => x.path === m[2])
  if (f) f.status = m[1].slice(0, 1)
}

const untracked = git(["ls-files", "--others", "--exclude-standard"])
  .split("\n")
  .filter(Boolean)

// Quality grep over the diff itself (not the full repo) — looks for
// anti-patterns that often slip through.
const diffBody = git(staged ? ["diff", "--cached"] : baseRef ? ["diff", `${baseRef}...HEAD`] : ["diff", "HEAD"])
const todos: string[] = []
const consoleLogs: string[] = []
const secrets: string[] = []
const secretRe = /(api[_-]?key|secret|password|hmac[_-]?secret|private[_-]?key|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,})\s*[:=]\s*["'][^"']{8,}["']/i
for (const line of diffBody.split("\n")) {
  if (!line.startsWith("+") || line.startsWith("+++")) continue
  const code = line.slice(1)
  if (/\b(TODO|FIXME|HACK|XXX)[: ]/.test(code)) todos.push(code.trim())
  if (/\bconsole\.log\b/.test(code)) consoleLogs.push(code.trim())
  if (secretRe.test(code)) secrets.push(code.trim())
}

const summary: Summary = {
  base: baseRef || "(staged)",
  files,
  totalIns,
  totalDel,
  newFiles,
  deletedFiles,
  untracked,
  todos: todos.slice(0, 10),
  consoleLogs: consoleLogs.slice(0, 10),
  secrets,
}

if (wantsJson) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.log(`# Diff summary — ${summary.base}`)
console.log("")
console.log(`Files changed: ${files.length}, +${totalIns} / -${totalDel}`)
console.log("")
if (files.length) {
  console.log("## Files")
  for (const f of files.slice(0, 30)) {
    console.log(`  ${f.status}  ${f.path}  (+${f.insertions} -${f.deletions})`)
  }
  if (files.length > 30) console.log(`  … and ${files.length - 30} more`)
  console.log("")
}
if (newFiles.length) {
  console.log(`## New files (${newFiles.length})`)
  for (const f of newFiles) console.log(`  ${f}`)
  console.log("")
}
if (deletedFiles.length) {
  console.log(`## Deleted files (${deletedFiles.length})`)
  for (const f of deletedFiles) console.log(`  ${f}`)
  console.log("")
}
if (untracked.length) {
  console.log(`## Untracked (${untracked.length})`)
  for (const f of untracked.slice(0, 10)) console.log(`  ${f}`)
  if (untracked.length > 10) console.log(`  … and ${untracked.length - 10} more`)
  console.log("")
}
if (secrets.length) {
  console.log(`## ⚠ Possible secrets in diff (${secrets.length})`)
  console.log("STOP and review these BEFORE committing:")
  for (const s of secrets) console.log(`  ${s}`)
  console.log("")
}
if (consoleLogs.length) {
  console.log(`## console.log left in diff (${consoleLogs.length})`)
  for (const c of consoleLogs) console.log(`  ${c}`)
  console.log("")
}
if (todos.length) {
  console.log(`## TODOs introduced in diff (${todos.length})`)
  for (const t of todos) console.log(`  ${t}`)
  console.log("")
}
