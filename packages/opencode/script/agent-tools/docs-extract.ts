#!/usr/bin/env bun
/**
 * docs-extract.ts — extract docs/repo URLs for project dependencies.
 *
 * When the agent needs to look up "what does <library> do" or "what
 * version of <library> introduced this API", it's faster to go
 * straight to the project's homepage/repo than to web-search and
 * filter. This tool parses your manifest(s) and emits a clean list:
 *
 *   <pkg>@<version>  →  homepage  →  repository
 *
 * Supports npm (package.json), Rust (Cargo.toml), Go (go.mod), and
 * Python (pyproject.toml). For npm we hit the registry API to fetch
 * `homepage` and `repository.url` since they're not in package.json
 * itself; everything else is parsed locally.
 *
 * Usage:
 *   bun docs-extract.ts                          # auto-detect
 *   bun docs-extract.ts --json
 *   bun docs-extract.ts --filter=react           # match a substring
 *   bun docs-extract.ts --manifest=path/to/file
 *
 * Combine with web-search (when you don't know the package) or
 * fetch-url (to actually read the docs after finding the URL).
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { argv } from "node:process"

interface PkgInfo {
  name: string
  version: string
  ecosystem: "npm" | "crates.io" | "Go" | "PyPI"
  homepage?: string
  repository?: string
  description?: string
}

const args = argv.slice(2)
const json = args.includes("--json")
const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1]?.toLowerCase() ?? ""
const manifest = args.find((a) => a.startsWith("--manifest="))?.split("=")[1]

const cwd = process.cwd()
const pkgs: PkgInfo[] = manifest ? readManifest(resolve(cwd, manifest)) : autoDetect(cwd)

if (pkgs.length === 0) {
  console.error("✗ no manifest found")
  process.exit(2)
}

const enriched = await enrich(pkgs)
const filtered = filter ? enriched.filter((p) => p.name.toLowerCase().includes(filter)) : enriched

if (json) {
  console.log(JSON.stringify(filtered, null, 2))
  process.exit(0)
}

console.log(`# Docs / repo links — ${filtered.length} package(s)\n`)
for (const p of filtered) {
  console.log(`${p.name}@${p.version}  (${p.ecosystem})`)
  if (p.description) console.log(`  ${p.description.slice(0, 200)}`)
  if (p.homepage) console.log(`  📚 ${p.homepage}`)
  if (p.repository) console.log(`  🔗 ${p.repository}`)
  console.log()
}

// ---------------------------------------------------------------------------
// Detection + parsers
// ---------------------------------------------------------------------------

function autoDetect(dir: string): PkgInfo[] {
  if (existsSync(resolve(dir, "package.json"))) return readNpm(dir)
  if (existsSync(resolve(dir, "Cargo.toml"))) return readCargo(resolve(dir, "Cargo.toml"))
  if (existsSync(resolve(dir, "go.mod"))) return readGoMod(resolve(dir, "go.mod"))
  if (existsSync(resolve(dir, "pyproject.toml"))) return readPyProject(resolve(dir, "pyproject.toml"))
  return []
}

function readManifest(p: string): PkgInfo[] {
  const lp = p.toLowerCase()
  if (lp.endsWith("package.json")) return readNpm(resolve(p, ".."))
  if (lp.endsWith("cargo.toml")) return readCargo(p)
  if (lp.endsWith("go.mod")) return readGoMod(p)
  if (lp.endsWith("pyproject.toml")) return readPyProject(p)
  throw new Error(`unsupported manifest: ${p}`)
}

function readNpm(dir: string): PkgInfo[] {
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

function readCargo(p: string): PkgInfo[] {
  // Lightweight TOML pass — handle [dependencies] / [dev-dependencies]
  // sections with `name = "x.y.z"` or `name = { version = "x.y.z" }`.
  const text = readFileSync(p, "utf8")
  const out: PkgInfo[] = []
  const sections = text.split(/^\[/m)
  for (const sec of sections) {
    if (!/^(?:dependencies|dev-dependencies|build-dependencies)\]/i.test(sec)) continue
    const body = sec.split(/\n\[/)[0]
    const re = /^([A-Za-z0-9_-]+)\s*=\s*("(?<v1>[^"]+)"|\{[^}]*?version\s*=\s*"(?<v2>[^"]+)"[^}]*\})/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const v = m.groups?.v1 ?? m.groups?.v2
      if (!v) continue
      out.push({
        name: m[1],
        version: v,
        ecosystem: "crates.io",
        homepage: `https://crates.io/crates/${m[1]}`,
        repository: `https://docs.rs/${m[1]}/${v}`,
      })
    }
  }
  return out
}

function readGoMod(p: string): PkgInfo[] {
  const text = readFileSync(p, "utf8")
  const out: PkgInfo[] = []
  const reqRe = /require\s+(\([\s\S]*?\)|\S+\s+v\S+)/g
  let m: RegExpExecArray | null
  while ((m = reqRe.exec(text)) !== null) {
    const block = m[1].startsWith("(") ? m[1].slice(1, -1) : m[1]
    for (const line of block.split("\n")) {
      const lm = /^\s*(\S+)\s+(v\S+)/.exec(line.trim())
      if (!lm) continue
      out.push({
        name: lm[1],
        version: lm[2],
        ecosystem: "Go",
        homepage: `https://${lm[1]}`,
        repository: `https://pkg.go.dev/${lm[1]}@${lm[2]}`,
      })
    }
  }
  return out
}

function readPyProject(p: string): PkgInfo[] {
  const text = readFileSync(p, "utf8")
  const out: PkgInfo[] = []
  // [tool.poetry.dependencies] / [project.dependencies]
  const re = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1] === "python") continue
    out.push({
      name: m[1],
      version: m[2],
      ecosystem: "PyPI",
      homepage: `https://pypi.org/project/${m[1]}/`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

async function enrich(pkgs: PkgInfo[]): Promise<PkgInfo[]> {
  // Only npm packages need a registry roundtrip; other ecosystems' homepages
  // are derivable (crates.io, pkg.go.dev). Limit concurrency to 8 to be
  // friendly to the public registry.
  const npm = pkgs.filter((p) => p.ecosystem === "npm")
  const others = pkgs.filter((p) => p.ecosystem !== "npm")
  const out: PkgInfo[] = [...others]
  let i = 0
  async function worker() {
    while (i < npm.length) {
      const p = npm[i++]
      try {
        const meta = await fetchNpmMeta(p.name)
        out.push({
          ...p,
          homepage: meta.homepage,
          repository: meta.repository,
          description: meta.description,
        })
      } catch {
        out.push({
          ...p,
          homepage: `https://www.npmjs.com/package/${p.name}`,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()))
  // Preserve original order roughly by name.
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

async function fetchNpmMeta(
  name: string,
): Promise<{ homepage?: string; repository?: string; description?: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}/latest`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`registry ${res.status}`)
    const j = (await res.json()) as {
      homepage?: string
      description?: string
      repository?: string | { url?: string }
    }
    const repoUrl = typeof j.repository === "string" ? j.repository : j.repository?.url
    return {
      homepage: j.homepage,
      repository: repoUrl?.replace(/^git\+/, "").replace(/\.git$/, ""),
      description: j.description,
    }
  } finally {
    clearTimeout(t)
  }
}
