#!/usr/bin/env bun
/**
 * Tail an opencode runtime log with structured filtering. Useful for
 * debugging what the running sidecar / cloud server is actually doing
 * while you're iterating in another process.
 *
 * Usage:
 *   bun script/agent-tools/runtime-tail.ts                         # tail the default log
 *   bun script/agent-tools/runtime-tail.ts --service team-reaper   # filter to one service
 *   bun script/agent-tools/runtime-tail.ts --grep error            # filter by substring
 *   bun script/agent-tools/runtime-tail.ts --since 5m              # last 5 minutes only
 *   bun script/agent-tools/runtime-tail.ts --follow                # continuous tail
 *
 * Default log location:
 *   ~/.local/share/openworm/log/dev.log (matches OpenCode's logging)
 *
 * Output format mirrors the source log so the agent can grep further
 * downstream.
 */

import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const args = process.argv.slice(2)

function flag(name: string): string | null {
  const i = args.indexOf("--" + name)
  if (i < 0) return null
  return args[i + 1] ?? null
}
const has = (name: string) => args.includes("--" + name)

const explicitPath = args.find((a, i) => i === 0 && !a.startsWith("--") && existsSync(a))
const candidates = [
  explicitPath,
  process.env.OPENCODE_LOG_PATH,
  path.join(homedir(), ".local/share/openworm/log/dev.log"),
  path.join(homedir(), ".local/share/opencode/log/dev.log"),
  path.join(homedir(), "AppData/Local/openworm/log/dev.log"),
].filter(Boolean) as string[]

const logPath = candidates.find((p) => existsSync(p))
if (!logPath) {
  console.error("runtime-tail: log file not found. Tried:")
  for (const c of candidates) console.error("  - " + c)
  process.exit(2)
}

const service = flag("service")
const grep = flag("grep")
const since = flag("since") // e.g. "5m", "1h"
const follow = has("follow")
const linesArg = flag("lines")
const tailLines = linesArg ? Number.parseInt(linesArg, 10) : 200

function parseSince(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/)
  if (!m) return 0
  const n = Number.parseInt(m[1], 10)
  const mul = m[2] === "s" ? 1 : m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86400
  return Date.now() - n * mul * 1000
}
const sinceMs = since ? parseSince(since) : 0

function lineMatches(line: string): boolean {
  if (service) {
    if (!new RegExp(`service=${service}\\b`).test(line)) return false
  }
  if (grep && !line.toLowerCase().includes(grep.toLowerCase())) return false
  if (sinceMs) {
    // Try to parse an ISO timestamp from the line head.
    const m = line.match(/^\w+\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
    if (m) {
      const ts = Date.parse(m[1] + "Z")
      if (Number.isFinite(ts) && ts < sinceMs) return false
    }
  }
  return true
}

// Initial dump: last N lines of the file.
let lastSize = 0
{
  const content = readFileSync(logPath, "utf8")
  const lines = content.split("\n")
  const slice = lines.slice(-tailLines)
  for (const line of slice) {
    if (line && lineMatches(line)) console.log(line)
  }
  lastSize = Buffer.byteLength(content, "utf8")
}

if (!follow) process.exit(0)

// Follow mode: re-read appended bytes when the file size grows.
console.error(`[runtime-tail] following ${logPath} …`)
watchFile(logPath, { interval: 500 }, (curr) => {
  if (curr.size <= lastSize) {
    if (curr.size < lastSize) {
      // Truncated / rotated — re-tail.
      lastSize = 0
    }
    return
  }
  const fd = readFileSync(logPath)
  const tail = fd.subarray(lastSize).toString("utf8")
  lastSize = curr.size
  for (const line of tail.split("\n")) {
    if (line && lineMatches(line)) console.log(line)
  }
})

process.on("SIGINT", () => {
  unwatchFile(logPath)
  console.error("\n[runtime-tail] stopped")
  process.exit(0)
})
