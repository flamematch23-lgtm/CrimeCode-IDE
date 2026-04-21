import { Tool } from "./tool"
import z from "zod"
import { execFile } from "child_process"
import { promisify } from "util"
import which from "which"

const exec = promisify(execFile)

async function locate(bin: string) {
  try {
    return await which(bin)
  } catch {
    return null
  }
}

async function run(bin: string, args: string[], timeout: number) {
  const path = await locate(bin)
  if (!path) {
    return {
      missing: true,
      output: `## ${bin} not installed\n\nInstall: see https://duckduckgo.com/?q=install+${bin}`,
      metadata: { tool: bin, missing: true },
    }
  }
  try {
    const { stdout, stderr } = await exec(path, args, { timeout, maxBuffer: 32 * 1024 * 1024 })
    return {
      missing: false,
      output: `## ${bin} ${args.join(" ")}\n\n\`\`\`\n${stdout || ""}${stderr ? `\n[stderr]\n${stderr}` : ""}\n\`\`\``,
      metadata: { tool: bin, args, stdoutBytes: stdout.length },
    }
  } catch (err: any) {
    return {
      missing: false,
      output: `## ${bin} failed\n\n\`\`\`\n${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message}\n\`\`\``,
      metadata: { tool: bin, args, error: err.message },
    }
  }
}

export const NmapTool = Tool.define("nmap", {
  description: "Wrapper around nmap. Runs the local nmap binary with provided flags. Authorized testing only.",
  parameters: z.object({
    target: z.string().describe("Target host/range/CIDR"),
    flags: z
      .string()
      .optional()
      .describe("Extra flags (default: '-sV -T4 -Pn --top-ports 1000'). Provide full custom flag string to override."),
    timeout: z.number().optional().describe("Timeout ms (default 300000)"),
  }),
  async execute(params) {
    const flags = (params.flags ?? "-sV -T4 -Pn --top-ports 1000").split(/\s+/).filter(Boolean)
    const r = await run("nmap", [...flags, params.target], params.timeout ?? 300000)
    return { title: `nmap ${params.target}`, output: r.output, metadata: r.metadata }
  },
})

export const NucleiTool = Tool.define("nuclei", {
  description: "Wrapper around projectdiscovery/nuclei. Runs templated vulnerability checks. Authorized testing only.",
  parameters: z.object({
    target: z.string().describe("Target URL or host"),
    templates: z.string().optional().describe("Template tag/path (default: cves,vulnerabilities)"),
    severity: z.string().optional().describe("Comma severities: critical,high,medium,low,info"),
    timeout: z.number().optional().describe("Timeout ms (default 600000)"),
  }),
  async execute(params) {
    const args = ["-u", params.target, "-silent", "-jsonl"]
    if (params.templates) args.push("-tags", params.templates)
    else args.push("-tags", "cves,vulnerabilities")
    if (params.severity) args.push("-severity", params.severity)
    const r = await run("nuclei", args, params.timeout ?? 600000)
    return { title: `nuclei ${params.target}`, output: r.output, metadata: r.metadata }
  },
})

export const SqlmapTool = Tool.define("sqlmap", {
  description: "Wrapper around sqlmap for SQL injection testing. Authorized testing only.",
  parameters: z.object({
    url: z.string().describe("Target URL with parameters"),
    data: z.string().optional().describe("POST data (e.g., 'user=*&pass=*')"),
    level: z.number().optional().describe("Test level 1-5 (default 1)"),
    risk: z.number().optional().describe("Risk 1-3 (default 1)"),
    flags: z.string().optional().describe("Extra flags (e.g., '--batch --dbs')"),
    timeout: z.number().optional().describe("Timeout ms (default 600000)"),
  }),
  async execute(params) {
    const args = ["-u", params.url, "--batch"]
    if (params.data) args.push("--data", params.data)
    if (params.level) args.push("--level", String(params.level))
    if (params.risk) args.push("--risk", String(params.risk))
    if (params.flags) args.push(...params.flags.split(/\s+/).filter(Boolean))
    const r = await run("sqlmap", args, params.timeout ?? 600000)
    return { title: `sqlmap ${params.url}`, output: r.output, metadata: r.metadata }
  },
})
