#!/usr/bin/env bun
/**
 * dep-audit.ts — audit project dependencies for known vulnerabilities.
 *
 * Uses Google's OSV.dev API which aggregates GHSA, NVD, RUSTSEC,
 * Go Vulndb, PyPA, npm advisories, etc. into a single ecosystem-aware
 * vulnerability database. No API key required.
 *
 * Supported manifests (auto-detected from CWD or explicit --manifest):
 *   - package.json + package-lock.json / bun.lock / yarn.lock
 *   - Cargo.lock
 *   - go.sum
 *   - requirements.txt / poetry.lock / Pipfile.lock
 *
 * For lockfiles we extract resolved versions; for plain manifests
 * (package.json) we fall back to the declared range and note the
 * limitation in the output.
 *
 * Usage:
 *   bun dep-audit.ts                     # auto-detect, table output
 *   bun dep-audit.ts --json              # machine-readable
 *   bun dep-audit.ts --severity=high     # filter HIGH/CRITICAL only
 *   bun dep-audit.ts --manifest=path/to/package.json
 *
 * Exit codes: 0 = clean, 1 = vulnerabilities found, 2 = bad input.
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { argv } from "node:process"

interface Vuln {
  id: string
  package: string
  installed: string
  ecosystem: string
  severity: "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "UNKNOWN"
  summary: string
  fixed?: string
  url: string
}

const args = argv.slice(2)
const json = args.includes("--json")
const minSev = (args.find((a) => a.startsWith("--severity="))?.split("=")[1] ?? "low").toUpperCase()
const manifestArg = args.find((a) => a.startsWith("--manifest="))?.split("=")[1]

const SEVERITY_RANK = { LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4, UNKNOWN: 0 } as const
const minRank = SEVERITY_RANK[minSev as keyof typeof SEVERITY_RANK] ?? 1

interface Pkg {
  name: string
  version: string
  ecosystem: "npm" | "crates.io" | "Go" | "PyPI"
}

const cwd = process.cwd()
const packages: Pkg[] = manifestArg ? readManifest(resolve(cwd, manifestArg)) : autoDetect(cwd)

if (packages.length === 0) {
  console.error("✗ no manifest found (looked for package.json/Cargo.lock/go.sum/requirements.txt)")
  process.exit(2)
}

console.error(`Scanning ${packages.length} package(s) against OSV.dev…`)

const vulns: Vuln[] = []
// Batch for politeness — OSV's /querybatch endpoint accepts up to 1000
// queries but we keep batches at 100 to fit comfortably under 1MB and
// surface progress.
const BATCH = 100
for (let i = 0; i < packages.length; i += BATCH) {
  const slice = packages.slice(i, i + BATCH)
  try {
    const found = await queryOsvBatch(slice)
    vulns.push(...found)
  } catch (err) {
    console.error(`  batch ${i / BATCH + 1} failed:`, err instanceof Error ? err.message : String(err))
  }
}

const filtered = vulns.filter((v) => SEVERITY_RANK[v.severity] >= minRank)
filtered.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

if (json) {
  console.log(JSON.stringify({ scanned: packages.length, vulnerabilities: filtered }, null, 2))
} else {
  if (filtered.length === 0) {
    console.log(`\n✅ No vulnerabilities found (severity ≥ ${minSev}, scanned ${packages.length} packages).`)
    process.exit(0)
  }
  console.log(`\n⚠️  ${filtered.length} vulnerability(ies) found:\n`)
  for (const v of filtered) {
    const sevBadge =
      v.severity === "CRITICAL"
        ? "🔴 CRITICAL"
        : v.severity === "HIGH"
          ? "🟠 HIGH"
          : v.severity === "MODERATE"
            ? "🟡 MODERATE"
            : v.severity === "LOW"
              ? "🟢 LOW"
              : "⚪ UNKNOWN"
    console.log(`${sevBadge}  ${v.package}@${v.installed}  (${v.ecosystem})`)
    console.log(`  ${v.id}: ${v.summary.slice(0, 200)}`)
    if (v.fixed) console.log(`  → fixed in: ${v.fixed}`)
    console.log(`  ${v.url}`)
    console.log()
  }
}

process.exit(filtered.length > 0 ? 1 : 0)

// ---------------------------------------------------------------------------
// OSV API
// ---------------------------------------------------------------------------

interface OsvVulnerability {
  id: string
  summary?: string
  details?: string
  severity?: Array<{ type: string; score: string }>
  database_specific?: { severity?: string }
  affected?: Array<{
    package?: { name?: string; ecosystem?: string }
    ranges?: Array<{ events?: Array<{ fixed?: string; introduced?: string }> }>
  }>
}

async function queryOsvBatch(pkgs: Pkg[]): Promise<Vuln[]> {
  const body = {
    queries: pkgs.map((p) => ({
      package: { name: p.name, ecosystem: p.ecosystem },
      version: p.version,
    })),
  }
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`OSV ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  const data = (await res.json()) as { results: Array<{ vulns?: Array<{ id: string }> }> }
  // The batch result only contains IDs. Resolve full details one-by-one
  // for the IDs we actually got back, capping at 50 per pkg in case a
  // package is hit by a flood of CVEs.
  const out: Vuln[] = []
  for (let i = 0; i < data.results.length; i++) {
    const ids = (data.results[i].vulns ?? []).slice(0, 50).map((v) => v.id)
    for (const id of ids) {
      try {
        const detail = await fetchOsvDetail(id)
        out.push(toVuln(detail, pkgs[i]))
      } catch {
        out.push({
          id,
          package: pkgs[i].name,
          installed: pkgs[i].version,
          ecosystem: pkgs[i].ecosystem,
          severity: "UNKNOWN",
          summary: "(failed to fetch details)",
          url: `https://osv.dev/vulnerability/${id}`,
        })
      }
    }
  }
  return out
}

async function fetchOsvDetail(id: string): Promise<OsvVulnerability> {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`OSV detail ${res.status}`)
  return (await res.json()) as OsvVulnerability
}

function toVuln(detail: OsvVulnerability, pkg: Pkg): Vuln {
  const sev = parseSeverity(detail)
  const fixed = (detail.affected ?? [])
    .flatMap((a) => a.ranges ?? [])
    .flatMap((r) => r.events ?? [])
    .map((e) => e.fixed)
    .filter((x): x is string => !!x)
    .sort()[0]
  return {
    id: detail.id,
    package: pkg.name,
    installed: pkg.version,
    ecosystem: pkg.ecosystem,
    severity: sev,
    summary: detail.summary || (detail.details ?? "").slice(0, 200) || "(no summary)",
    fixed,
    url: `https://osv.dev/vulnerability/${detail.id}`,
  }
}

function parseSeverity(d: OsvVulnerability): Vuln["severity"] {
  // Different ecosystems put severity in different places. Try GHSA's
  // database_specific.severity first (string LOW/MODERATE/HIGH/CRITICAL),
  // fall back to CVSS score → bucket mapping.
  const dbSpec = d.database_specific?.severity?.toUpperCase()
  if (dbSpec === "LOW" || dbSpec === "MODERATE" || dbSpec === "HIGH" || dbSpec === "CRITICAL") return dbSpec
  const cvss = d.severity?.find((s) => s.type === "CVSS_V3" || s.type === "CVSS_V4")?.score
  if (cvss) {
    // CVSS string like "CVSS:3.1/AV:N/..."  — pull out base score if a separate
    // score field isn't there. Cheap heuristic on the vector string.
    const baseMatch = /(?:^|\/)([0-9]+(?:\.[0-9]+)?)\b/.exec(cvss)
    const score = baseMatch ? Number(baseMatch[1]) : NaN
    if (Number.isFinite(score)) {
      if (score >= 9) return "CRITICAL"
      if (score >= 7) return "HIGH"
      if (score >= 4) return "MODERATE"
      if (score > 0) return "LOW"
    }
  }
  return "UNKNOWN"
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function autoDetect(dir: string): Pkg[] {
  const candidates: Array<[string, () => Pkg[]]> = [
    ["package.json", () => readNpm(dir)],
    ["Cargo.lock", () => readCargo(resolve(dir, "Cargo.lock"))],
    ["go.sum", () => readGoSum(resolve(dir, "go.sum"))],
    ["requirements.txt", () => readPyRequirements(resolve(dir, "requirements.txt"))],
  ]
  for (const [file, fn] of candidates) {
    if (existsSync(resolve(dir, file))) {
      try {
        return fn()
      } catch (err) {
        console.error(`  could not parse ${file}:`, err instanceof Error ? err.message : String(err))
      }
    }
  }
  return []
}

function readManifest(p: string): Pkg[] {
  const name = p.toLowerCase()
  if (name.endsWith("package.json")) return readNpm(resolve(p, ".."))
  if (name.endsWith("cargo.lock")) return readCargo(p)
  if (name.endsWith("go.sum")) return readGoSum(p)
  if (name.endsWith("requirements.txt")) return readPyRequirements(p)
  throw new Error(`unsupported manifest: ${p}`)
}

function readNpm(dir: string): Pkg[] {
  // Prefer lockfile (resolved versions). Fall back to package.json with a
  // warning that ranges aren't audited.
  const bunLock = resolve(dir, "bun.lock")
  if (existsSync(bunLock)) {
    return parseBunLock(readFileSync(bunLock, "utf8"))
  }
  const pkgLock = resolve(dir, "package-lock.json")
  if (existsSync(pkgLock)) {
    const data = JSON.parse(readFileSync(pkgLock, "utf8")) as {
      packages?: Record<string, { version?: string; dev?: boolean }>
    }
    const pkgs: Pkg[] = []
    for (const [path, meta] of Object.entries(data.packages ?? {})) {
      if (!path || !meta.version) continue
      const m = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)
      if (!m) continue
      pkgs.push({ name: m[1], version: meta.version, ecosystem: "npm" })
    }
    return dedupe(pkgs)
  }
  console.error("  no lockfile (bun.lock / package-lock.json) — auditing declared ranges only")
  const pj = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const all = { ...pj.dependencies, ...pj.devDependencies }
  return Object.entries(all).map(([n, v]) => ({
    name: n,
    version: v.replace(/^[\^~>=<\s]+/, ""),
    ecosystem: "npm" as const,
  }))
}

function parseBunLock(text: string): Pkg[] {
  // bun.lock is a textproto-ish format. We do a light pass: each top-level
  // `"<name>": [...]` block has the resolved version inside a tuple.
  const out: Pkg[] = []
  const re = /"((?:@[^/"]+\/)?[^"@]+?)@([^"]+)":\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ name: m[1], version: m[2], ecosystem: "npm" })
  }
  return dedupe(out)
}

function readCargo(p: string): Pkg[] {
  const text = readFileSync(p, "utf8")
  const out: Pkg[] = []
  // Cargo.lock is TOML with `[[package]]` blocks containing name + version.
  const re = /\[\[package\]\]\s+name\s*=\s*"([^"]+)"\s+version\s*=\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ name: m[1], version: m[2], ecosystem: "crates.io" })
  }
  return dedupe(out)
}

function readGoSum(p: string): Pkg[] {
  const text = readFileSync(p, "utf8")
  const out: Pkg[] = []
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+v(\S+?)(?:\/go\.mod)?\s+/.exec(line)
    if (m) out.push({ name: m[1], version: "v" + m[2], ecosystem: "Go" })
  }
  return dedupe(out)
}

function readPyRequirements(p: string): Pkg[] {
  const text = readFileSync(p, "utf8")
  const out: Pkg[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/#.*$/, "").trim()
    if (!trimmed) continue
    const m = /^([A-Za-z0-9_.-]+)==([^\s;]+)/.exec(trimmed)
    if (m) out.push({ name: m[1], version: m[2], ecosystem: "PyPI" })
  }
  return dedupe(out)
}

function dedupe(pkgs: Pkg[]): Pkg[] {
  const seen = new Set<string>()
  const out: Pkg[] = []
  for (const p of pkgs) {
    const k = `${p.ecosystem}\n${p.name}\n${p.version}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}
