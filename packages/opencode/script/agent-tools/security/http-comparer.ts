#!/usr/bin/env bun
/**
 * http-comparer.ts — Burp Suite Comparer equivalent.
 *
 * Diff two HTTP requests / responses (or any two text/JSON blobs) so
 * the agent can pinpoint exactly what changed between, say, an
 * authenticated and an unauthenticated request, two fuzzer hits, or
 * before/after a match-and-replace rule.
 *
 * Modes:
 *
 *   diff               unified diff with colour markers
 *   words              token-level diff (per word/symbol)
 *   bytes              byte-by-byte hexdump diff
 *   json               structural JSON diff (added/removed/changed paths)
 *   headers            compare two header sets only
 *   from-flows A B     pull two flows out of the proxy history DB
 *
 * Inputs come from:
 *   --left  PATH        file with the "left" content (or "-" for stdin)
 *   --right PATH        file with the "right" content
 *   --left-flow ID      pull from proxy history (request+response combined)
 *   --right-flow ID     pull from proxy history
 *   --left-string S
 *   --right-string S
 *
 * Output:
 *   default: human-readable unified diff
 *   --json:  structured diff hunks for downstream tools
 *
 * Examples:
 *
 *   bun http-comparer.ts diff --left a.txt --right b.txt
 *   bun http-comparer.ts json --left old.json --right new.json
 *   bun http-comparer.ts from-flows 12 14 --json
 */
import { argv } from "node:process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { makeArgs, bail, readStdin, formatBytes } from "./_lib/common.ts"

const cli = makeArgs(argv)
const mode = cli.args[0]
if (!mode || ["--help", "-h"].includes(mode)) usage(0)

const json = cli.has("--json")

if (mode === "diff") await modeUnified()
else if (mode === "words") await modeWords()
else if (mode === "bytes") await modeBytes()
else if (mode === "json") await modeJson()
else if (mode === "headers") await modeHeaders()
else if (mode === "from-flows") await modeFromFlows()
else usage(2)

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function getInput(side: "left" | "right"): Promise<string> {
  const path = cli.flag(`${side}`) || cli.flag(`${side}-file`)
  const str = cli.flag(`${side}-string`)
  if (str !== null && str !== undefined) return str
  if (path === "-") return await readStdin()
  if (path) return readFileSync(path, "utf8")
  bail(`missing --${side} (path or - for stdin) or --${side}-string`)
}

function pullFlow(id: number): { combined: string; meta: Record<string, unknown> } {
  const dataDir = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "crimecode",
    "proxy",
  )
  const dbPath = join(dataDir, "history.db")
  const db = new Database(dbPath, { readonly: true })
  const row = db.query("SELECT * FROM flows WHERE id = ?").get(id) as
    | {
        id: number
        method: string
        scheme: string
        host: string
        port: number
        path: string
        req_headers: string
        req_body: Buffer | null
        status: number
        resp_headers: string | null
        resp_body: Buffer | null
        resp_content_type: string | null
      }
    | undefined
  if (!row) bail(`no flow with id ${id} in proxy history`)
  const reqH = JSON.parse(row.req_headers) as Record<string, string>
  const respH = row.resp_headers ? (JSON.parse(row.resp_headers) as Record<string, string>) : {}
  const lines: string[] = []
  lines.push(`${row.method} ${row.scheme}://${row.host}${row.path}`)
  for (const [k, v] of Object.entries(reqH)) lines.push(`${k}: ${v}`)
  if (row.req_body && row.req_body.length > 0) {
    lines.push("")
    lines.push(row.req_body.toString("utf8"))
  }
  lines.push("")
  lines.push(`HTTP/1.1 ${row.status}`)
  for (const [k, v] of Object.entries(respH)) lines.push(`${k}: ${v}`)
  if (row.resp_body && row.resp_body.length > 0) {
    lines.push("")
    lines.push(row.resp_body.toString("utf8"))
  }
  return {
    combined: lines.join("\n"),
    meta: {
      id: row.id,
      url: `${row.scheme}://${row.host}${row.path}`,
      status: row.status,
      method: row.method,
    },
  }
}

// ---------------------------------------------------------------------------
// Mode: line diff
// ---------------------------------------------------------------------------

async function modeUnified() {
  const left = await getInput("left")
  const right = await getInput("right")
  const hunks = unifiedDiff(left, right, cli.num("context", 3))
  if (json) {
    console.log(JSON.stringify(hunks, null, 2))
    return
  }
  if (hunks.length === 0) {
    console.log("(identical)")
    return
  }
  printHunks(hunks, left, right)
}

interface Hunk {
  leftStart: number
  leftLen: number
  rightStart: number
  rightLen: number
  lines: Array<{ kind: " " | "+" | "-"; text: string }>
}

function unifiedDiff(a: string, b: string, ctx: number): Hunk[] {
  const aL = a.split("\n")
  const bL = b.split("\n")
  // Myers' diff via classic LCS table — fine for our input sizes.
  const lcs = lcsMatrix(aL, bL)
  const trace: Array<{ kind: " " | "+" | "-"; text: string }> = []
  let i = aL.length
  let j = bL.length
  while (i > 0 && j > 0) {
    if (aL[i - 1] === bL[j - 1]) {
      trace.push({ kind: " ", text: aL[i - 1] })
      i--
      j--
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      trace.push({ kind: "-", text: aL[i - 1] })
      i--
    } else {
      trace.push({ kind: "+", text: bL[j - 1] })
      j--
    }
  }
  while (i > 0) {
    trace.push({ kind: "-", text: aL[--i] })
  }
  while (j > 0) {
    trace.push({ kind: "+", text: bL[--j] })
  }
  trace.reverse()

  // Group into hunks with --context lines of unchanged surroundings.
  const hunks: Hunk[] = []
  let li = 0
  let ri = 0
  let cur: Hunk | null = null
  let unchangedRun = 0
  for (let k = 0; k < trace.length; k++) {
    const e = trace[k]
    if (e.kind === " ") {
      if (cur) {
        if (unchangedRun < ctx) {
          cur.lines.push(e)
          cur.leftLen++
          cur.rightLen++
        } else {
          // close hunk
          hunks.push(cur)
          cur = null
        }
        unchangedRun++
      }
      li++
      ri++
    } else {
      if (!cur) {
        // open hunk; backtrack ctx unchanged lines for context
        cur = {
          leftStart: Math.max(1, li + 1 - Math.min(ctx, unchangedRun)),
          leftLen: 0,
          rightStart: Math.max(1, ri + 1 - Math.min(ctx, unchangedRun)),
          rightLen: 0,
          lines: [],
        }
        // Look back through trace to copy unchanged context
        const back: typeof trace = []
        let kk = k - 1
        let collected = 0
        while (kk >= 0 && collected < ctx && trace[kk].kind === " ") {
          back.push(trace[kk])
          collected++
          kk--
        }
        back.reverse()
        for (const b of back) {
          cur.lines.push(b)
          cur.leftLen++
          cur.rightLen++
        }
      }
      cur.lines.push(e)
      if (e.kind === "-") {
        cur.leftLen++
        li++
      } else {
        cur.rightLen++
        ri++
      }
      unchangedRun = 0
    }
  }
  if (cur) hunks.push(cur)
  return hunks
}

function lcsMatrix(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp
}

function printHunks(hunks: Hunk[], _l: string, _r: string) {
  const colour = process.stdout.isTTY && !process.env.NO_COLOR
  const C_RED = colour ? "\x1b[31m" : ""
  const C_GREEN = colour ? "\x1b[32m" : ""
  const C_GREY = colour ? "\x1b[90m" : ""
  const C_RESET = colour ? "\x1b[0m" : ""
  console.log("--- left")
  console.log("+++ right")
  for (const h of hunks) {
    console.log(`${C_GREY}@@ -${h.leftStart},${h.leftLen} +${h.rightStart},${h.rightLen} @@${C_RESET}`)
    for (const l of h.lines) {
      const prefix = l.kind === "-" ? `${C_RED}-` : l.kind === "+" ? `${C_GREEN}+` : ` `
      console.log(`${prefix}${l.text}${C_RESET}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Mode: word diff
// ---------------------------------------------------------------------------

async function modeWords() {
  const left = await getInput("left")
  const right = await getInput("right")
  const lTokens = tokenize(left)
  const rTokens = tokenize(right)
  const ops = diffSequence(lTokens, rTokens)
  if (json) {
    console.log(JSON.stringify(ops, null, 2))
    return
  }
  const colour = process.stdout.isTTY && !process.env.NO_COLOR
  const C_RED = colour ? "\x1b[41m" : "[-"
  const C_GREEN = colour ? "\x1b[42m" : "[+"
  const C_RESET = colour ? "\x1b[0m" : "]"
  let out = ""
  for (const op of ops) {
    if (op.kind === "=") out += op.token
    else if (op.kind === "-") out += `${C_RED}${op.token}${C_RESET}`
    else if (op.kind === "+") out += `${C_GREEN}${op.token}${C_RESET}`
  }
  console.log(out)
}

function tokenize(s: string): string[] {
  return s.split(/(\s+|[^\w\s])/g).filter((x) => x.length > 0)
}

function diffSequence(a: string[], b: string[]): Array<{ kind: "=" | "-" | "+"; token: string }> {
  const dp = lcsMatrix(a, b)
  const out: Array<{ kind: "=" | "-" | "+"; token: string }> = []
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: "=", token: a[i - 1] })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ kind: "-", token: a[i - 1] })
      i--
    } else {
      out.push({ kind: "+", token: b[j - 1] })
      j--
    }
  }
  while (i > 0) out.push({ kind: "-", token: a[--i] })
  while (j > 0) out.push({ kind: "+", token: b[--j] })
  return out.reverse()
}

// ---------------------------------------------------------------------------
// Mode: bytes
// ---------------------------------------------------------------------------

async function modeBytes() {
  const left = Buffer.from(await getInput("left"), "utf8")
  const right = Buffer.from(await getInput("right"), "utf8")
  const max = Math.max(left.length, right.length)
  const diffs: Array<{ offset: number; left: number | null; right: number | null }> = []
  for (let i = 0; i < max; i++) {
    const l = i < left.length ? left[i] : null
    const r = i < right.length ? right[i] : null
    if (l !== r) diffs.push({ offset: i, left: l, right: r })
  }
  if (json) {
    console.log(
      JSON.stringify({ leftBytes: left.length, rightBytes: right.length, totalDiffs: diffs.length, diffs: diffs.slice(0, 1000) }, null, 2),
    )
    return
  }
  console.log(`# Bytes — ${formatBytes(left.length)} vs ${formatBytes(right.length)}, ${diffs.length} differing byte(s)\n`)
  if (diffs.length === 0) return
  for (const d of diffs.slice(0, 200)) {
    console.log(
      `0x${d.offset.toString(16).padStart(6, "0")}  ${d.left == null ? "--" : d.left.toString(16).padStart(2, "0")}  →  ${d.right == null ? "--" : d.right.toString(16).padStart(2, "0")}`,
    )
  }
  if (diffs.length > 200) console.log(`… ${diffs.length - 200} more`)
}

// ---------------------------------------------------------------------------
// Mode: json
// ---------------------------------------------------------------------------

async function modeJson() {
  const left = JSON.parse(await getInput("left"))
  const right = JSON.parse(await getInput("right"))
  const ops = jsonDiff(left, right, "$")
  if (json) {
    console.log(JSON.stringify(ops, null, 2))
    return
  }
  if (ops.length === 0) {
    console.log("(identical JSON)")
    return
  }
  console.log(`# JSON diff — ${ops.length} change(s)\n`)
  for (const op of ops) {
    if (op.kind === "added") console.log(`+ ${op.path} = ${shortVal(op.right)}`)
    else if (op.kind === "removed") console.log(`- ${op.path} = ${shortVal(op.left)}`)
    else console.log(`Δ ${op.path}: ${shortVal(op.left)} → ${shortVal(op.right)}`)
  }
}

interface JsonOp {
  path: string
  kind: "added" | "removed" | "changed"
  left?: unknown
  right?: unknown
}

function jsonDiff(a: unknown, b: unknown, path: string): JsonOp[] {
  if (a === b) return []
  if (a === undefined) return [{ path, kind: "added", right: b }]
  if (b === undefined) return [{ path, kind: "removed", left: a }]
  if (typeof a !== typeof b || a === null || b === null) {
    return [{ path, kind: "changed", left: a, right: b }]
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ops: JsonOp[] = []
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i++) {
      ops.push(...jsonDiff(a[i], b[i], `${path}[${i}]`))
    }
    return ops
  }
  if (typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
    const ops: JsonOp[] = []
    for (const k of keys) {
      ops.push(
        ...jsonDiff(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          /^\w+$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`,
        ),
      )
    }
    return ops
  }
  return [{ path, kind: "changed", left: a, right: b }]
}

function shortVal(v: unknown): string {
  const s = JSON.stringify(v)
  return s.length > 80 ? s.slice(0, 77) + "…" : s
}

// ---------------------------------------------------------------------------
// Mode: headers
// ---------------------------------------------------------------------------

async function modeHeaders() {
  const left = parseHeadersBlock(await getInput("left"))
  const right = parseHeadersBlock(await getInput("right"))
  const allKeys = new Set([...Object.keys(left), ...Object.keys(right)].map((k) => k.toLowerCase()))
  const diffs: Array<{ name: string; left?: string; right?: string; kind: "added" | "removed" | "changed" }> = []
  for (const k of allKeys) {
    const lv = findCaseInsensitive(left, k)
    const rv = findCaseInsensitive(right, k)
    if (lv === undefined && rv !== undefined) diffs.push({ name: k, right: rv, kind: "added" })
    else if (rv === undefined && lv !== undefined) diffs.push({ name: k, left: lv, kind: "removed" })
    else if (lv !== rv) diffs.push({ name: k, left: lv, right: rv, kind: "changed" })
  }
  if (json) {
    console.log(JSON.stringify(diffs, null, 2))
    return
  }
  if (diffs.length === 0) console.log("(headers identical)")
  else {
    console.log(`# Headers — ${diffs.length} change(s)\n`)
    for (const d of diffs) {
      if (d.kind === "added") console.log(`+ ${d.name}: ${d.right}`)
      else if (d.kind === "removed") console.log(`- ${d.name}: ${d.left}`)
      else console.log(`Δ ${d.name}: ${d.left} → ${d.right}`)
    }
  }
}

function parseHeadersBlock(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split("\n")) {
    if (!line.trim()) continue
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function findCaseInsensitive(o: Record<string, string>, k: string): string | undefined {
  for (const key of Object.keys(o)) if (key.toLowerCase() === k) return o[key]
  return undefined
}

// ---------------------------------------------------------------------------
// Mode: from-flows
// ---------------------------------------------------------------------------

async function modeFromFlows() {
  const a = Number(cli.args[1])
  const b = Number(cli.args[2])
  if (!Number.isFinite(a) || !Number.isFinite(b)) bail("usage: from-flows <leftId> <rightId>")
  const L = pullFlow(a)
  const R = pullFlow(b)
  const hunks = unifiedDiff(L.combined, R.combined, cli.num("context", 3))
  if (json) {
    console.log(JSON.stringify({ left: L.meta, right: R.meta, hunks }, null, 2))
    return
  }
  console.log(`# Comparing flow #${a} ↔ #${b}\n`)
  console.log(`left:  ${JSON.stringify(L.meta)}`)
  console.log(`right: ${JSON.stringify(R.meta)}\n`)
  if (hunks.length === 0) console.log("(identical)")
  else printHunks(hunks, L.combined, R.combined)
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`http-comparer.ts <mode> [flags]

Modes:
  diff        unified line diff (default)
  words       per-token diff
  bytes       byte-by-byte hex diff
  json        structural JSON diff
  headers     header-set diff
  from-flows <leftId> <rightId>   diff two captured proxy flows

Inputs (any combination):
  --left PATH | --left-string S | --left=- (stdin)
  --right PATH | --right-string S

Common: --json --context N
`)
  process.exit(code)
}
