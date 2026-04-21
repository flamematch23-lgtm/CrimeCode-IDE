#!/usr/bin/env bun

/**
 * Upstream release audit script for CrimeCode.
 *
 * Fetches releases from the upstream `sst/opencode` repository,
 * compares them against the local codebase, and generates a
 * report for selective backport decisions.
 *
 * Usage:
 *   bun run script/upstream-audit.ts                # audit latest upstream release
 *   bun run script/upstream-audit.ts --tag v1.5.0   # audit a specific tag
 *   bun run script/upstream-audit.ts --list         # list all upstream releases
 *   bun run script/upstream-audit.ts --since v1.4.3 # audit all releases since a tag
 */

import { $ } from "bun"

const UPSTREAM = "https://github.com/sst/opencode.git"
const REMOTE = "upstream"
const REPO = "sst/opencode"

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const param = (name: string) => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

const list = flag("list")
const tag = param("tag")
const since = param("since")
const json = flag("json")

// ── Helpers ───────────────────────────────────────────────────────────

async function run(cmd: string) {
  const result = await $`${cmd.split(" ")}`.quiet().nothrow()
  return result.stdout.toString().trim()
}

async function ok(cmd: string) {
  const result = await $`${cmd.split(" ")}`.quiet().nothrow()
  return result.exitCode === 0
}

async function ensure() {
  const exists = await ok(`git remote get-url ${REMOTE}`)
  if (!exists) {
    console.log(`Adding remote '${REMOTE}' → ${UPSTREAM}`)
    await $`git remote add ${REMOTE} ${UPSTREAM}`.quiet().nothrow()
  }
  console.log("Fetching upstream tags...")
  await $`git fetch ${REMOTE} --tags --force`.quiet().nothrow()
}

async function tags(): Promise<string[]> {
  const raw = await run(`git tag -l v*`)
  if (!raw) return []
  return raw
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+/.test(t))
    .sort((a, b) => {
      const pa = a.replace(/^v/, "").split(".").map(Number)
      const pb = b.replace(/^v/, "").split(".").map(Number)
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
      }
      return 0
    })
}

async function releases(): Promise<Array<{ tag: string; date: string; name: string }>> {
  try {
    const raw = await $`gh release list --repo ${REPO} --limit 50 --json tagName,publishedAt,name`.quiet()
    const data: Array<{ tagName: string; publishedAt: string; name: string }> = JSON.parse(raw.stdout.toString())
    return data.map((r) => ({
      tag: r.tagName,
      date: r.publishedAt.slice(0, 10),
      name: r.name,
    }))
  } catch {
    // fallback to git tags if gh is not available
    const all = await tags()
    return all.map((t) => ({ tag: t, date: "", name: t }))
  }
}

interface DiffStat {
  file: string
  added: number
  removed: number
}

async function diff(ref: string): Promise<DiffStat[]> {
  const raw = await $`git diff --numstat HEAD...${ref}`.quiet().nothrow()
  const text = raw.stdout.toString().trim()
  if (!text) return []
  return text.split("\n").map((line) => {
    const [a, r, ...parts] = line.split("\t")
    return {
      file: parts.join("\t"),
      added: a === "-" ? 0 : parseInt(a, 10),
      removed: r === "-" ? 0 : parseInt(r, 10),
    }
  })
}

async function local(): Promise<string[]> {
  const raw = await $`git log --oneline -1 HEAD`.quiet().nothrow()
  const text = raw.stdout.toString().trim()
  return text ? [text] : []
}

function categorize(files: DiffStat[]) {
  const buckets = {
    core: [] as DiffStat[],
    ui: [] as DiffStat[],
    sdk: [] as DiffStat[],
    infra: [] as DiffStat[],
    docs: [] as DiffStat[],
    test: [] as DiffStat[],
    other: [] as DiffStat[],
  }
  for (const f of files) {
    if (f.file.startsWith("packages/opencode/src/")) buckets.core.push(f)
    else if (
      f.file.startsWith("packages/app/") ||
      f.file.startsWith("packages/ui/") ||
      f.file.startsWith("packages/web/")
    )
      buckets.ui.push(f)
    else if (f.file.startsWith("packages/sdk/")) buckets.sdk.push(f)
    else if (f.file.startsWith(".github/") || f.file.startsWith("packages/desktop/") || f.file.startsWith("script/"))
      buckets.infra.push(f)
    else if (f.file.endsWith(".md") || f.file.startsWith("docs/")) buckets.docs.push(f)
    else if (f.file.includes("test") || f.file.includes("spec") || f.file.includes("fixture")) buckets.test.push(f)
    else buckets.other.push(f)
  }
  return buckets
}

// ── Known CrimeCode-modified paths ───────────────────────────────────
// These are paths we've heavily modified during branding/feature work.
// Upstream changes to these files need manual review before backporting.

const MODIFIED_PATTERNS = [
  "packages/opencode/src/cli/",
  "packages/opencode/src/server/routes/global.ts",
  "packages/opencode/src/installation/",
  "packages/opencode/script/build.ts",
  "packages/app/src/components/dialog-settings.tsx",
  "packages/app/src/context/platform.tsx",
  "packages/app/src/utils/server-health.ts",
  "packages/desktop/src/index.tsx",
  "packages/desktop/vite.config.ts",
  "packages/desktop/src-tauri/tauri.prod.conf.json",
  "packages/desktop/src-tauri/tauri.beta.conf.json",
  "packages/web/src/content/i18n/",
  "packages/ui/src/theme/",
  "packages/desktop-electron/package.json",
  ".github/workflows/",
]

function conflicts(file: string): boolean {
  return MODIFIED_PATTERNS.some((p) => file.startsWith(p))
}

// ── Report ────────────────────────────────────────────────────────────

interface AuditReport {
  tag: string
  total: number
  categories: Record<string, number>
  conflicting: DiffStat[]
  safe: DiffStat[]
}

function report(tag: string, stats: DiffStat[]): AuditReport {
  const cats = categorize(stats)
  const categories: Record<string, number> = {}
  for (const [k, v] of Object.entries(cats)) {
    if (v.length > 0) categories[k] = v.length
  }

  const conflicting = stats.filter((s) => conflicts(s.file))
  const safe = stats.filter((s) => !conflicts(s.file))

  return { tag, total: stats.length, categories, conflicting, safe }
}

function render(r: AuditReport) {
  console.log("")
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`  Upstream Audit: ${r.tag}`)
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`  Total changed files: ${r.total}`)
  console.log("")

  console.log("  By category:")
  for (const [k, v] of Object.entries(r.categories)) {
    console.log(`    ${k.padEnd(10)} ${v} files`)
  }

  console.log("")
  console.log(`  CONFLICTS (${r.conflicting.length} files overlap with CrimeCode mods):`)
  if (r.conflicting.length === 0) {
    console.log("    (none — clean backport possible)")
  } else {
    for (const f of r.conflicting) {
      console.log(`    ! ${f.file}  (+${f.added} -${f.removed})`)
    }
  }

  console.log("")
  console.log(`  SAFE to backport (${r.safe.length} files):`)
  if (r.safe.length === 0) {
    console.log("    (none)")
  } else {
    const top = r.safe.sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 20)
    for (const f of top) {
      console.log(`    + ${f.file}  (+${f.added} -${f.removed})`)
    }
    if (r.safe.length > 20) {
      console.log(`    ... and ${r.safe.length - 20} more`)
    }
  }
  console.log("")
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  await ensure()

  // --list: show all upstream releases
  if (list) {
    const all = await releases()
    console.log("\nUpstream releases:")
    for (const r of all) {
      console.log(`  ${r.tag.padEnd(12)} ${r.date}  ${r.name}`)
    }
    return
  }

  const all = await tags()
  if (all.length === 0) {
    console.error("No upstream tags found. Is the upstream remote reachable?")
    process.exit(1)
  }

  // --tag: audit a specific tag
  if (tag) {
    const ref = tag.startsWith("v") ? tag : `v${tag}`
    if (!all.includes(ref)) {
      console.error(`Tag '${ref}' not found. Available: ${all.slice(-5).join(", ")}`)
      process.exit(1)
    }
    const stats = await diff(ref)
    const r = report(ref, stats)
    if (json) {
      console.log(JSON.stringify(r, null, 2))
    } else {
      render(r)
    }
    return
  }

  // --since: audit all releases since a tag
  if (since) {
    const ref = since.startsWith("v") ? since : `v${since}`
    const idx = all.indexOf(ref)
    if (idx < 0) {
      console.error(`Tag '${ref}' not found. Available: ${all.slice(-5).join(", ")}`)
      process.exit(1)
    }
    const newer = all.slice(idx + 1)
    if (newer.length === 0) {
      console.log(`No releases newer than ${ref}`)
      return
    }
    const reports: AuditReport[] = []
    for (const t of newer) {
      const stats = await diff(t)
      const r = report(t, stats)
      reports.push(r)
      if (!json) render(r)
    }
    if (json) console.log(JSON.stringify(reports, null, 2))
    return
  }

  // Default: audit the latest upstream tag
  const latest = all.at(-1)!
  const head = await local()
  console.log(`\nLocal HEAD: ${head[0] ?? "(unknown)"}`)
  console.log(`Latest upstream tag: ${latest}`)

  const stats = await diff(latest)
  const r = report(latest, stats)
  if (json) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    render(r)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
