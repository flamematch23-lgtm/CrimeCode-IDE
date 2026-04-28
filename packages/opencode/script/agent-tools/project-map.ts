#!/usr/bin/env bun
/**
 * Generate a structured map of the project as JSON. Drop-in for the
 * `onboarding-overview` skill: one tool call replaces the typical
 * 30-tool-call cold-start exploration.
 *
 * Usage:
 *   bun script/agent-tools/project-map.ts                 # current dir
 *   bun script/agent-tools/project-map.ts /path/to/repo
 *   bun script/agent-tools/project-map.ts --hot 10        # show top 10 hot files
 *   bun script/agent-tools/project-map.ts --json          # raw JSON output
 *
 * Output (default): markdown summary
 * Output (--json):  JSON for further processing
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"

interface ProjectMap {
  name: string
  origin: string | null
  recentCommits: string[]
  type: "monorepo" | "single" | "unknown"
  packageManager: string | null
  workspaces: string[]
  languages: string[]
  buildCommands: Record<string, string>
  envVars: string[]
  migrations: { dir: string | null; framework: string | null }
  entryPoints: string[]
  hotFiles: Array<{ file: string; commits: number }>
  todoCount: number
  testFramework: string | null
}

const args = process.argv.slice(2)
const wantsJson = args.includes("--json")
const hotN = (() => {
  const i = args.indexOf("--hot")
  if (i >= 0 && args[i + 1]) return Number.parseInt(args[i + 1], 10)
  return 5
})()
const root = args.find((a) => !a.startsWith("--") && existsSync(a)) ?? process.cwd()

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function git(args: string[], opts: { cwd: string }): string {
  return safe(
    () => execFileSync("git", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim(),
    "",
  )
}

function readJson<T>(p: string): T | null {
  return safe(() => JSON.parse(readFileSync(p, "utf8")) as T, null)
}

function listDir(p: string): string[] {
  return safe(() => readdirSync(p), [])
}

function detect(): ProjectMap {
  const m: ProjectMap = {
    name: path.basename(root),
    origin: git(["remote", "get-url", "origin"], { cwd: root }) || null,
    recentCommits: git(["log", "--oneline", "-5"], { cwd: root })
      .split("\n")
      .filter(Boolean),
    type: "single",
    packageManager: null,
    workspaces: [],
    languages: [],
    buildCommands: {},
    envVars: [],
    migrations: { dir: null, framework: null },
    entryPoints: [],
    hotFiles: [],
    todoCount: 0,
    testFramework: null,
  }

  // Monorepo / packages
  const pkg = readJson<Record<string, unknown>>(path.join(root, "package.json"))
  if (pkg) {
    m.languages.push("typescript")
    if (pkg.packageManager) m.packageManager = String(pkg.packageManager)
    if (pkg.workspaces) {
      m.type = "monorepo"
      // Collect package names by scanning the conventional `packages/`
      // directory. Wildcard matches in package.json don't matter to us
      // here — we just want a flat list.
      const pkgsDir = path.join(root, "packages")
      if (existsSync(pkgsDir)) {
        for (const sub of listDir(pkgsDir)) {
          const p = path.join(pkgsDir, sub, "package.json")
          if (existsSync(p)) {
            const name = (readJson<{ name?: string }>(p)?.name ?? sub) as string
            m.workspaces.push(name)
          }
        }
      }
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    for (const k of ["dev", "start", "build", "test", "typecheck", "lint", "format"]) {
      if (scripts[k]) m.buildCommands[k] = scripts[k]
    }
  }
  if (existsSync(path.join(root, "Cargo.toml"))) m.languages.push("rust")
  if (existsSync(path.join(root, "go.mod"))) m.languages.push("go")
  if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "requirements.txt"))) {
    m.languages.push("python")
  }

  // Test framework
  if (pkg) {
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) } as Record<string, string>
    if (deps.vitest) m.testFramework = "vitest"
    else if (deps.jest) m.testFramework = "jest"
    else if (m.languages.includes("typescript")) m.testFramework = "bun:test"
  }

  // Migrations
  for (const candidate of ["migration", "migrations", "db/migrations", "prisma/migrations"]) {
    if (existsSync(path.join(root, candidate))) {
      m.migrations.dir = candidate
      const inside = listDir(path.join(root, candidate))
      if (inside.some((f) => f.includes("schema.prisma"))) m.migrations.framework = "prisma"
      else if (inside.some((f) => /^\d{14,}_/.test(f))) m.migrations.framework = "drizzle-or-custom"
      break
    }
  }

  // Entry points
  const candidates = [
    "packages/opencode/src/index.ts",
    "packages/desktop-electron/src/main/index.ts",
    "packages/app/src/entry.tsx",
    "src/index.ts",
    "src/main.ts",
    "src/app.ts",
    "main.go",
    "src/main.rs",
  ]
  for (const c of candidates) {
    if (existsSync(path.join(root, c))) m.entryPoints.push(c)
  }

  // Env vars (rough — grep across TS sources)
  const envRe = /process\.env\.([A-Z_][A-Z0-9_]+)/g
  const collectFrom = (dir: string, depth = 0) => {
    if (depth > 6) return
    for (const entry of listDir(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      const st = safe(() => statSync(full), null)
      if (!st) continue
      if (st.isDirectory()) collectFrom(full, depth + 1)
      else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        const txt = safe(() => readFileSync(full, "utf8"), "")
        let mm
        while ((mm = envRe.exec(txt))) m.envVars.push(mm[1])
      }
    }
  }
  // Only scan a couple of well-known dirs so this stays fast on big repos.
  for (const seed of ["packages/opencode/src", "packages/app/src", "packages/desktop-electron/src", "src"]) {
    if (existsSync(path.join(root, seed))) collectFrom(path.join(root, seed))
  }
  m.envVars = [...new Set(m.envVars)].sort()

  // Hot files
  const since30d = git(["log", "--pretty=format:", "--name-only", "--since=30 days ago"], { cwd: root })
  if (since30d) {
    const counts = new Map<string, number>()
    for (const line of since30d.split("\n")) {
      const f = line.trim()
      if (!f) continue
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    m.hotFiles = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, hotN)
      .map(([file, commits]) => ({ file, commits }))
  }

  // TODO count
  const todoOut = safe(
    () =>
      execFileSync(
        "git",
        ["grep", "-cE", "TODO|FIXME|XXX|HACK"],
        { cwd: root, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
      ),
    "",
  )
  m.todoCount = todoOut.split("\n").reduce((a, line) => a + (Number.parseInt(line.split(":").pop() ?? "0", 10) || 0), 0)

  return m
}

const m = detect()

if (wantsJson) {
  console.log(JSON.stringify(m, null, 2))
} else {
  // Markdown summary
  console.log(`# ${m.name}`)
  if (m.origin) console.log(`*Origin:* ${m.origin}`)
  console.log("")
  console.log("## Recent commits")
  for (const c of m.recentCommits) console.log(`- ${c}`)
  console.log("")
  console.log("## Layout")
  console.log(`- Type: ${m.type}`)
  console.log(`- Languages: ${m.languages.join(", ") || "?"}`)
  if (m.workspaces.length) console.log(`- Workspaces (${m.workspaces.length}): ${m.workspaces.slice(0, 8).join(", ")}${m.workspaces.length > 8 ? "…" : ""}`)
  console.log("")
  console.log("## Build / test")
  for (const [k, v] of Object.entries(m.buildCommands)) console.log(`- \`${k}\` — \`${v}\``)
  if (m.testFramework) console.log(`- Test framework: ${m.testFramework}`)
  console.log("")
  console.log("## Entry points")
  for (const e of m.entryPoints) console.log(`- ${e}`)
  console.log("")
  console.log("## Persistence")
  if (m.migrations.dir) {
    console.log(`- Migrations: ${m.migrations.dir} (framework: ${m.migrations.framework ?? "unknown"})`)
  } else {
    console.log("- No migrations directory found")
  }
  console.log("")
  console.log(`## Env vars (${m.envVars.length})`)
  console.log(m.envVars.length ? m.envVars.map((v) => `\`${v}\``).join(", ") : "_(none detected)_")
  console.log("")
  console.log(`## Hot files — last 30 days`)
  for (const h of m.hotFiles) console.log(`- ${h.file} — ${h.commits} commits`)
  console.log("")
  console.log(`## Open work signals`)
  console.log(`- TODOs / FIXMEs in tree: ${m.todoCount}`)
}
