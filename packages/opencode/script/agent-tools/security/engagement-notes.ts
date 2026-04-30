#!/usr/bin/env bun
/**
 * engagement-notes.ts — Burp's "Engagement Tools → Notes" + Issue tracker.
 *
 * A persistent notes / findings store for a security engagement. The agent
 * uses this to:
 *   - jot a target reconnaissance summary
 *   - record findings with severity, CWE, repro steps
 *   - tag them with affected URLs / flow IDs / scan IDs
 *   - export the whole thing as Markdown for a final report
 *
 * Schema (sqlite, $XDG_DATA_HOME/crimecode/notes/notes.db):
 *
 *   notes(id, ts, project, kind, title, body, tags, refs)
 *     - kind: 'finding' | 'note' | 'todo' | 'evidence'
 *     - tags: comma-sep
 *     - refs: JSON {flowId?, scanId?, url?, cve?}
 *
 *   findings(id, ts, project, severity, cwe, title, description,
 *            impact, recommendation, repro_steps, refs, status)
 *     - severity: 'info'|'low'|'medium'|'high'|'critical'
 *     - status:   'open'|'triaged'|'fixed'|'wontfix'|'duplicate'
 *
 * Usage:
 *   bun engagement-notes.ts add-note    --project foo --title "..." --body "..." --tags a,b
 *   bun engagement-notes.ts add-finding --project foo --severity high --cwe CWE-89 \
 *       --title "SQLi on /api/search" --description "..." --impact "..." --recommendation "..." \
 *       --refs '{"url":"...","flowId":42}'
 *   bun engagement-notes.ts list        --project foo [--kind finding] [--severity high] [--json]
 *   bun engagement-notes.ts show        <id> [--json]
 *   bun engagement-notes.ts edit        <id> --status fixed
 *   bun engagement-notes.ts delete      <id> --yes
 *   bun engagement-notes.ts report      --project foo > report.md
 *
 * The report mode emits a Markdown engagement report with:
 *   - Executive summary (counts by severity)
 *   - Findings (by severity, descending)
 *   - Notes / observations
 *   - Appendix with raw JSON evidence
 */
import { argv } from "node:process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { makeArgs, bail, ok, info } from "./_lib/common.ts"

const DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "crimecode",
  "notes",
)
mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = join(DATA_DIR, "notes.db")

const db = new Database(DB_PATH)
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  tags TEXT,
  refs TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project);
CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  project TEXT NOT NULL,
  severity TEXT NOT NULL,
  cwe TEXT,
  title TEXT NOT NULL,
  description TEXT,
  impact TEXT,
  recommendation TEXT,
  repro_steps TEXT,
  refs TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
`)

const cli = makeArgs(argv)
const cmd = cli.args[0]
if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

const json = cli.has("--json")

if (cmd === "add-note") cmdAddNote()
else if (cmd === "add-finding") cmdAddFinding()
else if (cmd === "list") cmdList()
else if (cmd === "show") cmdShow()
else if (cmd === "edit") cmdEdit()
else if (cmd === "delete") cmdDelete()
else if (cmd === "report") cmdReport()
else if (cmd === "stats") cmdStats()
else usage(2)

// ---------------------------------------------------------------------------
// Add note / finding
// ---------------------------------------------------------------------------

function cmdAddNote() {
  const project = cli.required("project")
  const kind = cli.flag("kind") ?? "note"
  if (!["note", "todo", "evidence"].includes(kind)) bail(`bad --kind ${kind}`)
  const title = cli.required("title")
  const body = cli.flag("body") ?? ""
  const tags = cli.flag("tags") ?? ""
  const refs = cli.flag("refs") ?? null
  if (refs) try { JSON.parse(refs) } catch { bail(`--refs is not valid JSON: ${refs}`) }
  const id = db
    .run(
      "INSERT INTO notes (ts, project, kind, title, body, tags, refs) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [Date.now(), project, kind, title, body, tags, refs],
    )
    .lastInsertRowid
  if (json) console.log(JSON.stringify({ ok: true, id }))
  else ok(`note #${id} added (${kind})`)
}

const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const
const STATUSES = ["open", "triaged", "fixed", "wontfix", "duplicate"] as const

function cmdAddFinding() {
  const project = cli.required("project")
  const severity = cli.required("severity") as (typeof SEVERITIES)[number]
  if (!SEVERITIES.includes(severity)) bail(`--severity must be one of ${SEVERITIES.join(", ")}`)
  const cwe = cli.flag("cwe") ?? null
  const title = cli.required("title")
  const description = cli.flag("description") ?? ""
  const impact = cli.flag("impact") ?? ""
  const recommendation = cli.flag("recommendation") ?? ""
  const repro = cli.flag("repro") ?? cli.flag("repro-steps") ?? ""
  const refs = cli.flag("refs") ?? null
  if (refs) try { JSON.parse(refs) } catch { bail(`--refs is not valid JSON: ${refs}`) }
  const status = cli.flag("status") ?? "open"
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) bail(`--status must be one of ${STATUSES.join(", ")}`)
  const id = db
    .run(
      `INSERT INTO findings
       (ts, project, severity, cwe, title, description, impact, recommendation, repro_steps, refs, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), project, severity, cwe, title, description, impact, recommendation, repro, refs, status],
    )
    .lastInsertRowid
  if (json) console.log(JSON.stringify({ ok: true, id }))
  else ok(`finding #${id} added (${severity})`)
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface Row {
  id: number
  ts: number
  project: string
  kind?: string
  severity?: string
  title: string
  body?: string | null
  description?: string | null
  tags?: string | null
  refs?: string | null
  status?: string
  cwe?: string | null
  impact?: string | null
  recommendation?: string | null
  repro_steps?: string | null
}

function cmdList() {
  const project = cli.flag("project")
  const kind = cli.flag("kind")
  const severity = cli.flag("severity")
  const status = cli.flag("status")
  const limit = cli.num("limit", 100)

  let notes: Row[] = []
  let findings: Row[] = []
  const wantNotes = !severity && !status && (!kind || ["note", "todo", "evidence"].includes(kind))
  const wantFindings = !kind || kind === "finding"

  if (wantNotes) {
    let sql = "SELECT * FROM notes"
    const where: string[] = []
    const params: unknown[] = []
    if (project) {
      where.push("project = ?")
      params.push(project)
    }
    if (kind && kind !== "finding") {
      where.push("kind = ?")
      params.push(kind)
    }
    if (where.length) sql += " WHERE " + where.join(" AND ")
    sql += " ORDER BY id DESC LIMIT ?"
    params.push(limit)
    notes = db.query(sql).all(...(params as never[])) as Row[]
  }

  if (wantFindings) {
    let sql = "SELECT * FROM findings"
    const where: string[] = []
    const params: unknown[] = []
    if (project) {
      where.push("project = ?")
      params.push(project)
    }
    if (severity) {
      where.push("severity = ?")
      params.push(severity)
    }
    if (status) {
      where.push("status = ?")
      params.push(status)
    }
    if (where.length) sql += " WHERE " + where.join(" AND ")
    sql += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, id DESC LIMIT ?"
    params.push(limit)
    findings = db.query(sql).all(...(params as never[])) as Row[]
  }

  if (json) {
    console.log(JSON.stringify({ findings, notes }, null, 2))
    return
  }
  if (findings.length > 0) {
    console.log(`# Findings (${findings.length})`)
    for (const f of findings) {
      const sev = (f.severity ?? "?").toUpperCase().padEnd(8)
      const tag = colorForSeverity(f.severity ?? "")
      console.log(`  ${tag}[${sev}]\x1b[0m  #${String(f.id).padEnd(4)} ${f.title}  (${f.cwe ?? "-"}, ${f.status ?? "-"})`)
    }
    console.log()
  }
  if (notes.length > 0) {
    console.log(`# Notes (${notes.length})`)
    for (const n of notes) {
      const k = (n.kind ?? "note").padEnd(8)
      console.log(`  [${k}]  #${String(n.id).padEnd(4)} ${n.title}  ${n.tags ? `(${n.tags})` : ""}`)
    }
  }
  if (findings.length === 0 && notes.length === 0) console.log("(no entries)")
}

function colorForSeverity(s: string): string {
  if (s === "critical") return "\x1b[1;31m"
  if (s === "high") return "\x1b[31m"
  if (s === "medium") return "\x1b[33m"
  if (s === "low") return "\x1b[36m"
  return "\x1b[90m"
}

function cmdShow() {
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: show <id>")
  // Try findings first, then notes
  const fin = db.query("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined
  const note = db.query("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined
  const row = fin ?? note
  if (!row) bail(`no entry #${id}`)
  const isFinding = !!fin
  if (json) {
    console.log(
      JSON.stringify(
        {
          ...row,
          refs: row.refs ? JSON.parse(row.refs) : null,
          isFinding,
        },
        null,
        2,
      ),
    )
    return
  }
  if (isFinding) {
    console.log(`# Finding #${row.id}  [${(row.severity ?? "").toUpperCase()}]  ${row.title}`)
    console.log(`Project: ${row.project}    Status: ${row.status}    CWE: ${row.cwe ?? "-"}`)
    console.log(`When: ${new Date(row.ts).toISOString()}\n`)
    if (row.description) console.log(`## Description\n${row.description}\n`)
    if (row.impact) console.log(`## Impact\n${row.impact}\n`)
    if (row.recommendation) console.log(`## Recommendation\n${row.recommendation}\n`)
    if (row.repro_steps) console.log(`## Repro\n${row.repro_steps}\n`)
    if (row.refs) console.log(`## Refs\n${row.refs}\n`)
  } else {
    console.log(`# Note #${row.id}  [${row.kind}]  ${row.title}`)
    console.log(`Project: ${row.project}   Tags: ${row.tags ?? "-"}\n`)
    if (row.body) console.log(row.body)
    if (row.refs) console.log(`\nRefs: ${row.refs}`)
  }
}

function cmdEdit() {
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: edit <id> [--status ... | --severity ... | ...]")
  const fields: Array<[string, string]> = []
  for (const k of ["status", "severity", "title", "description", "impact", "recommendation", "repro_steps", "cwe", "tags", "body"]) {
    const v = cli.flag(k.replace(/_/g, "-"))
    if (v !== null) fields.push([k, v])
  }
  if (fields.length === 0) bail("nothing to update — pass at least one --field value")

  // Try findings first
  const fin = db.query("SELECT id FROM findings WHERE id = ?").get(id) as { id: number } | undefined
  if (fin) {
    const sets = fields.map(([k]) => `${k} = ?`).join(", ")
    db.run(`UPDATE findings SET ${sets} WHERE id = ?`, [...fields.map(([, v]) => v), id])
    if (json) console.log(JSON.stringify({ ok: true, id, table: "findings" }))
    else ok(`finding #${id} updated`)
    return
  }
  const note = db.query("SELECT id FROM notes WHERE id = ?").get(id) as { id: number } | undefined
  if (note) {
    const allowedNoteFields = new Set(["title", "body", "tags"])
    const filtered = fields.filter(([k]) => allowedNoteFields.has(k))
    if (filtered.length === 0) bail("notes only support title, body, tags")
    const sets = filtered.map(([k]) => `${k} = ?`).join(", ")
    db.run(`UPDATE notes SET ${sets} WHERE id = ?`, [...filtered.map(([, v]) => v), id])
    if (json) console.log(JSON.stringify({ ok: true, id, table: "notes" }))
    else ok(`note #${id} updated`)
    return
  }
  bail(`no entry #${id}`)
}

function cmdDelete() {
  if (!cli.has("--yes")) bail("delete requires --yes")
  const id = Number(cli.args[1])
  if (!Number.isFinite(id)) bail("usage: delete <id> --yes")
  const f = db.query("SELECT id FROM findings WHERE id = ?").get(id) as { id: number } | undefined
  if (f) {
    db.run("DELETE FROM findings WHERE id = ?", [id])
    ok(`finding #${id} deleted`)
    return
  }
  const n = db.query("SELECT id FROM notes WHERE id = ?").get(id) as { id: number } | undefined
  if (n) {
    db.run("DELETE FROM notes WHERE id = ?", [id])
    ok(`note #${id} deleted`)
    return
  }
  bail(`no entry #${id}`)
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function cmdReport() {
  const project = cli.required("project")
  const findings = db
    .query(
      `SELECT * FROM findings WHERE project = ?
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
    )
    .all(project) as Row[]
  const notes = db.query("SELECT * FROM notes WHERE project = ? ORDER BY id ASC").all(project) as Row[]

  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.severity ?? "?"] = (counts[f.severity ?? "?"] ?? 0) + 1

  let md = `# Engagement Report — ${project}\n`
  md += `\n_Generated ${new Date().toISOString()}_\n`
  md += `\n## Executive Summary\n\n`
  md += `| Severity | Count |\n|---|---|\n`
  for (const s of SEVERITIES) md += `| ${s} | ${counts[s] ?? 0} |\n`
  md += `\n**Total findings: ${findings.length}**\n`

  md += `\n## Findings\n`
  if (findings.length === 0) {
    md += `\n_No findings recorded._\n`
  } else {
    for (const f of findings) {
      md += `\n### F-${f.id} · [${(f.severity ?? "").toUpperCase()}] ${f.title}\n`
      md += `\n- **Status:** ${f.status}  ·  **CWE:** ${f.cwe ?? "-"}\n`
      md += `- **Recorded:** ${new Date(f.ts).toISOString()}\n`
      if (f.description) md += `\n**Description:**\n\n${f.description}\n`
      if (f.impact) md += `\n**Impact:**\n\n${f.impact}\n`
      if (f.recommendation) md += `\n**Recommendation:**\n\n${f.recommendation}\n`
      if (f.repro_steps) md += `\n**Reproduction:**\n\n${f.repro_steps}\n`
      if (f.refs) md += `\n**References:** \`${f.refs}\`\n`
    }
  }

  if (notes.length > 0) {
    md += `\n## Notes & Observations\n`
    for (const n of notes) {
      md += `\n### N-${n.id} · [${n.kind}] ${n.title}\n`
      if (n.body) md += `\n${n.body}\n`
      if (n.tags) md += `\n_Tags: ${n.tags}_\n`
    }
  }

  console.log(md)
}

function cmdStats() {
  const total = (db.query("SELECT COUNT(*) AS c FROM findings").get() as { c: number }).c
  const projects = db
    .query("SELECT project, COUNT(*) AS n FROM findings GROUP BY project ORDER BY n DESC")
    .all() as Array<{ project: string; n: number }>
  const sev = db.query("SELECT severity, COUNT(*) AS n FROM findings GROUP BY severity").all() as Array<{
    severity: string
    n: number
  }>
  if (json) {
    console.log(JSON.stringify({ total, projects, severities: sev }, null, 2))
    return
  }
  console.log(`Total findings: ${total}`)
  console.log(`By severity:`)
  for (const s of sev) console.log(`  ${s.severity}: ${s.n}`)
  console.log(`Top projects:`)
  for (const p of projects.slice(0, 10)) console.log(`  ${p.project}: ${p.n}`)
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`engagement-notes.ts <command> [flags]

Persistent notes + findings for a security engagement.

Commands:
  add-note    --project P --title T [--kind note|todo|evidence]
              [--body B] [--tags a,b] [--refs '{"url":"...","flowId":42}']

  add-finding --project P --severity info|low|medium|high|critical \\
              --title T [--cwe CWE-79] [--description D] [--impact I] \\
              [--recommendation R] [--repro 'curl ...'] [--refs JSON] \\
              [--status open|triaged|fixed|wontfix|duplicate]

  list        [--project P] [--kind finding|note|todo|evidence] \\
              [--severity S] [--status S] [--limit N] [--json]

  show        <id> [--json]

  edit        <id> [--status S --severity S --title ... --body ... ...]

  delete      <id> --yes

  report      --project P                                 → Markdown to stdout

  stats       [--json]

Storage: ${DATA_DIR}
`)
  process.exit(code)
}
