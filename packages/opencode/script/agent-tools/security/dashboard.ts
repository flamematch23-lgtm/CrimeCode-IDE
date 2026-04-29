#!/usr/bin/env bun
/**
 * dashboard.ts — interactive TUI dashboard for the Burp-Suite-style toolkit.
 *
 * Splits the terminal into panels:
 *   ┌──────────────────── Proxy Status ───────────────────────────────┐
 *   │ listening: 127.0.0.1:8181  intercept: ON   flows: 142            │
 *   ├──────────────────── Recent Flows ────────────────────────────────┤
 *   │ #142  GET  https://x.com/login            200  3.2 KB  120 ms    │
 *   │ #141  POST https://x.com/api/sign         204  0.0 KB   55 ms    │
 *   │ ...                                                              │
 *   ├──────────────────── Findings (passive batch) ────────────────────┤
 *   │ [HIGH]   xss-reflected  https://x.com/search?q=...               │
 *   │ ...                                                              │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Keys:
 *   q         quit
 *   tab       cycle focus between panels (Flows / Findings / Rules)
 *   ↑↓ / j k  move in current panel
 *   enter     show selected flow / finding / rule in detail
 *   /         filter the focused list
 *   r         re-run passive batch scan over history
 *   i         toggle proxy intercept on/off
 *   s         dump current state to ~/.crimecode-burp-snapshot.json
 *   ?         help overlay
 *
 * Implementation:
 *   no curses dependency — pure ANSI + raw stdin. Works under
 *   ssh / tmux / VS Code terminal. Re-renders on a timer (200 ms)
 *   plus on every key event.
 */
import { argv, stdout, stdin } from "node:process"
import { join } from "node:path"
import { homedir } from "node:os"
import { writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"
import { makeArgs, formatBytes, bail } from "./_lib/common.ts"

const cli = makeArgs(argv)
if (cli.has("--help") || cli.has("-h")) usage(0)

const DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "crimecode",
  "proxy",
)
const DB_PATH = join(DATA_DIR, "history.db")
if (!existsSync(DB_PATH)) {
  bail(`no proxy DB at ${DB_PATH} — run \`http-proxy.ts start\` once to create it`)
}
const db = new Database(DB_PATH, { readonly: false })

interface FlowRow {
  id: number
  ts: number
  method: string
  scheme: string
  host: string
  path: string
  status: number | null
  resp_body_size: number | null
  duration_ms: number | null
  flagged: number
}

interface RuleRow {
  id: number
  enabled: number
  type: string
  scope: string
  match: string
  replace: string
  description: string | null
}

type PanelName = "flows" | "findings" | "rules"

interface State {
  panel: PanelName
  flows: FlowRow[]
  findings: Finding[]
  rules: RuleRow[]
  cursor: { flows: number; findings: number; rules: number }
  filter: string
  filterBuffer: string | null // null = not filtering, "" = empty filter being typed
  detail: string | null
  toast: string | null
  toastUntil: number
}

interface Finding {
  severity: string
  title: string
  location?: string
  flowId?: number
}

const state: State = {
  panel: "flows",
  flows: [],
  findings: [],
  rules: [],
  cursor: { flows: 0, findings: 0, rules: 0 },
  filter: "",
  filterBuffer: null,
  detail: null,
  toast: null,
  toastUntil: 0,
}

await refreshAll()

stdout.write("\x1b[?25l\x1b[?1049h") // hide cursor + alt screen
stdin.setRawMode(true)
stdin.resume()
stdin.setEncoding("utf8")

let dirty = true
const refreshTimer = setInterval(async () => {
  await refreshAll()
  dirty = true
}, 2000)
const renderTimer = setInterval(() => {
  if (dirty) {
    render()
    dirty = false
  }
}, 50)

stdin.on("data", async (key) => {
  await onKey(key.toString())
  dirty = true
})

process.on("SIGINT", () => quit(0))
process.on("SIGTERM", () => quit(0))

// ---------------------------------------------------------------------------

async function refreshAll() {
  const filter = state.filter.toLowerCase()
  const flows = db
    .query<FlowRow, []>(
      "SELECT id, ts, method, scheme, host, path, status, resp_body_size, duration_ms, flagged FROM flows ORDER BY id DESC LIMIT 200",
    )
    .all() as FlowRow[]
  state.flows = filter
    ? flows.filter(
        (f) =>
          (f.host + f.path).toLowerCase().includes(filter) ||
          f.method.toLowerCase().includes(filter) ||
          String(f.status ?? "").includes(filter),
      )
    : flows

  state.rules = db
    .query<RuleRow, []>("SELECT id, enabled, type, scope, match, replace, description FROM rules ORDER BY id DESC")
    .all() as RuleRow[]

  // Findings: run passive batch (silently). Parse JSON output of vuln-scanner.
  // We cache the result for 5 seconds to avoid hammering.
  if (Date.now() - lastFindingsAt > 5_000) {
    state.findings = await loadFindings()
    lastFindingsAt = Date.now()
  }

  // Clamp cursors
  state.cursor.flows = Math.min(state.cursor.flows, Math.max(0, state.flows.length - 1))
  state.cursor.findings = Math.min(state.cursor.findings, Math.max(0, state.findings.length - 1))
  state.cursor.rules = Math.min(state.cursor.rules, Math.max(0, state.rules.length - 1))
}

let lastFindingsAt = 0
async function loadFindings(): Promise<Finding[]> {
  // Inline: re-read the most recent flows and run a tiny subset of passive checks.
  // Using a child process would be more accurate but slower for the dashboard.
  const flows = db
    .query<
      {
        id: number
        scheme: string
        host: string
        path: string
        resp_headers: string | null
        resp_body: Buffer | null
        status: number | null
      },
      []
    >("SELECT id, scheme, host, path, resp_headers, resp_body, status FROM flows ORDER BY id DESC LIMIT 100")
    .all() as Array<{
    id: number
    scheme: string
    host: string
    path: string
    resp_headers: string | null
    resp_body: Buffer | null
    status: number | null
  }>
  const out: Finding[] = []
  for (const f of flows) {
    const headers: Record<string, string> = f.resp_headers ? JSON.parse(f.resp_headers) : {}
    const body = f.resp_body ? f.resp_body.toString("utf8").slice(0, 16_384) : ""
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
    if (!lower["content-security-policy"] && f.scheme === "https" && f.status === 200) {
      out.push({ severity: "low", title: "missing CSP", location: `${f.host}${f.path}`, flowId: f.id })
    }
    if (!lower["x-content-type-options"] && f.status === 200) {
      out.push({ severity: "low", title: "missing X-Content-Type-Options", location: `${f.host}${f.path}`, flowId: f.id })
    }
    if (lower["x-powered-by"]) {
      out.push({
        severity: "info",
        title: `X-Powered-By: ${lower["x-powered-by"]}`,
        location: `${f.host}${f.path}`,
        flowId: f.id,
      })
    }
    if (/Traceback|java\.lang\.\w+Exception|panic:/.test(body)) {
      out.push({ severity: "high", title: "stack trace leaked", location: `${f.host}${f.path}`, flowId: f.id })
    }
    if (/SQL syntax|sqlstate|ORA-\d|sqlite3\.Operational/i.test(body)) {
      out.push({ severity: "high", title: "SQL error in response", location: `${f.host}${f.path}`, flowId: f.id })
    }
    if (/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(body)) {
      out.push({ severity: "info", title: "JWT in response body", location: `${f.host}${f.path}`, flowId: f.id })
    }
  }
  // dedupe
  const seen = new Set<string>()
  return out.filter((f) => {
    const k = `${f.severity}|${f.title}|${f.location}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const w = stdout.columns ?? 100
  const h = stdout.rows ?? 30
  const lines: string[] = []
  lines.push(header(w))
  lines.push(...flowsPanel(w, Math.floor((h - 6) * 0.45)))
  lines.push(...findingsPanel(w, Math.floor((h - 6) * 0.35)))
  lines.push(...rulesPanel(w, Math.max(3, h - 6 - Math.floor((h - 6) * 0.45) - Math.floor((h - 6) * 0.35))))
  lines.push(footer(w))
  if (state.detail) {
    lines.push(...renderDetailOverlay(w, h))
  } else if (state.filterBuffer !== null) {
    lines.push(`╔${"═".repeat(w - 2)}╗`)
    lines.push(`║ filter ▶ ${state.filterBuffer.padEnd(w - 14)}║`)
    lines.push(`╚${"═".repeat(w - 2)}╝`)
  }
  stdout.write("\x1b[H" + lines.join("\n") + "\x1b[J")
}

function header(w: number): string {
  const interceptOn = readSetting("intercept") === "1"
  const flowCount = (db.query("SELECT COUNT(*) AS c FROM flows").get() as { c: number }).c
  const port = readSetting("port") ?? "?"
  const txt = ` CrimeCode Burp Toolkit  ·  proxy 127.0.0.1:${port}  ·  intercept ${
    interceptOn ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m"
  }  ·  ${flowCount} flows total `
  return `\x1b[44m${txt}\x1b[0m${" ".repeat(Math.max(0, w - visibleLen(txt)))}`
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length
}

function panelTitle(name: string, focused: boolean, w: number): string {
  const tag = focused ? `\x1b[1;7m ${name} \x1b[0m` : `\x1b[2m ${name} \x1b[0m`
  return tag + "─".repeat(Math.max(0, w - visibleLen(tag) - 1))
}

function flowsPanel(w: number, h: number): string[] {
  const lines: string[] = []
  lines.push(panelTitle("Flows", state.panel === "flows", w))
  const visibleRows = Math.max(1, h - 1)
  const cursor = state.cursor.flows
  const top = Math.max(0, Math.min(state.flows.length - visibleRows, cursor - Math.floor(visibleRows / 2)))
  for (let i = 0; i < visibleRows; i++) {
    const row = state.flows[top + i]
    if (!row) {
      lines.push(" ")
      continue
    }
    const line = ` ${state.panel === "flows" && top + i === cursor ? "▶" : " "} #${String(row.id).padEnd(6)} ${row.method.padEnd(6)} ${row.scheme}://${row.host}${row.path}`
    const meta = ` ${String(row.status ?? "-")}  ${formatBytes(row.resp_body_size ?? 0).padStart(8)}  ${String(row.duration_ms ?? "-").padStart(4)}ms`
    const trimmed = (line + " ").padEnd(w - meta.length).slice(0, w - meta.length) + meta
    lines.push(state.panel === "flows" && top + i === cursor ? `\x1b[7m${trimmed}\x1b[0m` : trimmed)
  }
  return lines
}

function findingsPanel(w: number, h: number): string[] {
  const lines: string[] = []
  lines.push(panelTitle("Findings (passive)", state.panel === "findings", w))
  const visibleRows = Math.max(1, h - 1)
  const top = Math.max(
    0,
    Math.min(state.findings.length - visibleRows, state.cursor.findings - Math.floor(visibleRows / 2)),
  )
  const sevCol: Record<string, string> = {
    info: "\x1b[90m",
    low: "\x1b[36m",
    medium: "\x1b[33m",
    high: "\x1b[31m",
    critical: "\x1b[1;31m",
  }
  for (let i = 0; i < visibleRows; i++) {
    const f = state.findings[top + i]
    if (!f) {
      lines.push(" ")
      continue
    }
    const sev = `${sevCol[f.severity] ?? ""}[${f.severity.toUpperCase()}]\x1b[0m`
    const line = ` ${state.panel === "findings" && top + i === state.cursor.findings ? "▶" : " "} ${sev} ${f.title}  ${f.location ?? ""}${f.flowId ? "  #" + f.flowId : ""}`
    const trimmed = padTo(line, w)
    lines.push(state.panel === "findings" && top + i === state.cursor.findings ? `\x1b[7m${trimmed}\x1b[0m` : trimmed)
  }
  return lines
}

function rulesPanel(w: number, h: number): string[] {
  const lines: string[] = []
  lines.push(panelTitle("Match-and-Replace Rules", state.panel === "rules", w))
  const visibleRows = Math.max(1, h - 1)
  const top = Math.max(0, Math.min(state.rules.length - visibleRows, state.cursor.rules - Math.floor(visibleRows / 2)))
  for (let i = 0; i < visibleRows; i++) {
    const r = state.rules[top + i]
    if (!r) {
      lines.push(" ")
      continue
    }
    const line = ` ${state.panel === "rules" && top + i === state.cursor.rules ? "▶" : " "} #${String(r.id).padEnd(3)} ${r.enabled ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m"} ${r.type}/${r.scope}  ${r.match} → ${r.replace}`
    const trimmed = padTo(line, w)
    lines.push(state.panel === "rules" && top + i === state.cursor.rules ? `\x1b[7m${trimmed}\x1b[0m` : trimmed)
  }
  return lines
}

function footer(w: number): string {
  const help =
    " q quit  ·  tab cycle  ·  ↑↓ jk move  ·  enter detail  ·  / filter  ·  i intercept  ·  r refresh  ·  s snapshot  ·  ? help "
  const toast = state.toast && Date.now() < state.toastUntil ? `  \x1b[33m${state.toast}\x1b[0m` : ""
  return `\x1b[44m${(help + toast).padEnd(w)}\x1b[0m`
}

function padTo(s: string, w: number): string {
  const visible = visibleLen(s)
  if (visible >= w) {
    // truncate while preserving ANSI — naive: strip ANSI before slicing
    let plain = s.replace(/\x1b\[[0-9;]*m/g, "")
    plain = plain.slice(0, w)
    return plain
  }
  return s + " ".repeat(w - visible)
}

function renderDetailOverlay(w: number, h: number): string[] {
  const top = 2
  const left = 2
  const innerW = w - 4
  const innerH = h - 4
  const lines = (state.detail ?? "").split("\n")
  const out: string[] = []
  out.push(`\x1b[${top};${left}H╔${"═".repeat(innerW)}╗`)
  for (let i = 0; i < innerH - 2; i++) {
    out.push(
      `\x1b[${top + 1 + i};${left}H║ ${(lines[i] ?? "").slice(0, innerW - 2).padEnd(innerW - 2)} ║`,
    )
  }
  out.push(`\x1b[${top + innerH - 1};${left}H╚${"═".repeat(innerW)}╝`)
  out.push(`\x1b[${top + innerH - 1};${left + 2}H╡ esc / q to close ╞`)
  return out
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

async function onKey(key: string) {
  // Handle filter-buffer mode
  if (state.filterBuffer !== null) {
    if (key === "\r" || key === "\n") {
      state.filter = state.filterBuffer
      state.filterBuffer = null
      await refreshAll()
      return
    }
    if (key === "\x1b" || key === "\x03") {
      state.filterBuffer = null
      return
    }
    if (key === "\x7f" || key === "\b") {
      state.filterBuffer = state.filterBuffer.slice(0, -1)
      return
    }
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      state.filterBuffer += key
      return
    }
    return
  }

  // detail overlay
  if (state.detail !== null) {
    if (key === "\x1b" || key === "q" || key === "\r") state.detail = null
    return
  }

  if (key === "q" || key === "\x03") quit(0)
  else if (key === "\t") {
    state.panel = state.panel === "flows" ? "findings" : state.panel === "findings" ? "rules" : "flows"
  } else if (key === "/") {
    state.filterBuffer = state.filter
  } else if (key === "?") {
    state.detail = HELP_TEXT
  } else if (key === "i") {
    const cur = readSetting("intercept") === "1"
    writeSetting("intercept", cur ? "0" : "1")
    toast(`intercept → ${cur ? "OFF" : "ON"}`)
  } else if (key === "r") {
    lastFindingsAt = 0
    await refreshAll()
    toast(`refreshed`)
  } else if (key === "s") {
    const path = join(homedir(), ".crimecode-burp-snapshot.json")
    writeFileSync(path, JSON.stringify({ flows: state.flows, findings: state.findings, rules: state.rules }, null, 2))
    toast(`snapshot → ${path}`)
  } else if (key === "\x1b[A" || key === "k") {
    moveCursor(-1)
  } else if (key === "\x1b[B" || key === "j") {
    moveCursor(1)
  } else if (key === "\x1b[5~") {
    moveCursor(-10)
  } else if (key === "\x1b[6~") {
    moveCursor(10)
  } else if (key === "g") {
    state.cursor[state.panel] = 0
  } else if (key === "G") {
    state.cursor[state.panel] = arr().length - 1
  } else if (key === "\r" || key === "\n") {
    await openDetail()
  } else if (key === "x" && state.panel === "rules") {
    const r = state.rules[state.cursor.rules]
    if (r) {
      db.run("UPDATE rules SET enabled = 1 - enabled WHERE id = ?", [r.id])
      toast(`rule #${r.id} toggled`)
    }
  } else if (key === "d" && state.panel === "rules") {
    const r = state.rules[state.cursor.rules]
    if (r) {
      db.run("DELETE FROM rules WHERE id = ?", [r.id])
      toast(`rule #${r.id} deleted`)
    }
  } else if (key === "f" && state.panel === "flows") {
    const f = state.flows[state.cursor.flows]
    if (f) {
      db.run("UPDATE flows SET flagged = 1 - flagged WHERE id = ?", [f.id])
      toast(`flow #${f.id} ${f.flagged ? "unflagged" : "flagged"}`)
    }
  } else if (key === "p" && state.panel === "flows") {
    const f = state.flows[state.cursor.flows]
    if (f) {
      // Run repeater on this flow
      const out = spawnSync(
        "bun",
        [
          join(__dirname, "http-proxy.ts"),
          "send-to-repeater",
          String(f.id),
        ],
        { encoding: "utf8" },
      )
      state.detail = `Send-to-repeater payload (#${f.id}):\n\n${out.stdout || out.stderr}`
    }
  }
}

function arr(): unknown[] {
  return state.panel === "flows" ? state.flows : state.panel === "findings" ? state.findings : state.rules
}

function moveCursor(delta: number) {
  const a = arr()
  state.cursor[state.panel] = Math.max(0, Math.min(a.length - 1, state.cursor[state.panel] + delta))
}

async function openDetail() {
  if (state.panel === "flows") {
    const f = state.flows[state.cursor.flows]
    if (!f) return
    const out = spawnSync("bun", [join(__dirname, "http-proxy.ts"), "show", String(f.id)], { encoding: "utf8" })
    state.detail = (out.stdout || out.stderr).slice(0, 8000)
  } else if (state.panel === "findings") {
    const f = state.findings[state.cursor.findings]
    if (!f) return
    state.detail = JSON.stringify(f, null, 2)
    if (f.flowId) {
      const out = spawnSync("bun", [join(__dirname, "http-proxy.ts"), "show", String(f.flowId)], { encoding: "utf8" })
      state.detail += "\n\n--- flow ---\n" + out.stdout
    }
  } else if (state.panel === "rules") {
    const r = state.rules[state.cursor.rules]
    if (!r) return
    state.detail = JSON.stringify(r, null, 2)
  }
}

function toast(msg: string) {
  state.toast = msg
  state.toastUntil = Date.now() + 2500
}

// ---------------------------------------------------------------------------
// Settings access
// ---------------------------------------------------------------------------

function readSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value ?? null
}
function writeSetting(key: string, value: string) {
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ])
}

// ---------------------------------------------------------------------------

function quit(code: number): never {
  clearInterval(refreshTimer)
  clearInterval(renderTimer)
  stdout.write("\x1b[?25h\x1b[?1049l")
  if (stdin.setRawMode) stdin.setRawMode(false)
  process.exit(code)
}

function usage(code: number): never {
  console.error(`dashboard.ts — interactive TUI for the security toolkit

Usage:
  bun dashboard.ts

Reads from:
  ${DB_PATH}

Run \`http-proxy.ts start\` first so the DB exists.
`)
  process.exit(code)
}

const HELP_TEXT = `
CrimeCode Burp Toolkit Dashboard
================================

Tab cycles between three panels:

  Flows                   captured proxy traffic
  Findings (passive)      lightweight scan over recent responses
  Rules                   match-and-replace rewrites

Keys
----

  q  / Ctrl+C     quit
  tab             next panel
  ↑↓ / j k        move
  PgUp/PgDown     jump 10
  g / G           top / bottom
  enter           open the selected item in detail
  /               filter the focused list (case-insensitive)
  i               toggle proxy interception (writes to settings DB)
  r               force refresh of findings
  s               snapshot current view → ~/.crimecode-burp-snapshot.json

Per-panel:

  Flows:  f flag/unflag  ·  p send-to-repeater payload
  Rules:  x toggle enabled  ·  d delete rule

The dashboard is a thin viewer — most edits go via the http-proxy.ts
match-and-replace subcommand, the AI agent's burp_toolkit tool, or
direct SQL on the proxy history DB.
`
