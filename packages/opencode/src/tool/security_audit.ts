import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./security_audit.txt"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

function parseNpmVulns(raw: string): string | null {
  try {
    const data = JSON.parse(raw)
    const v = data.metadata?.vulnerabilities || {}
    const count = Object.values(v).reduce<number>((s, n) => s + (n as number), 0)
    return (
      `Summary: ${count} vulnerabilities` +
      ` (info:${v.info || 0} low:${v.low || 0} moderate:${v.moderate || 0}` +
      ` high:${v.high || 0} critical:${v.critical || 0})\n\n` +
      JSON.stringify(data.vulnerabilities ?? {}, null, 2).slice(0, 3000)
    )
  } catch {
    return null
  }
}

function parseYarnVulns(raw: string): string | null {
  try {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      const obj = JSON.parse(line)
      if (obj.type === "auditSummary") {
        const v = obj.data?.vulnerabilities ?? {}
        const count = Object.values(v).reduce<number>((s, n) => s + (n as number), 0)
        return `Summary: ${count} vulnerabilities (${JSON.stringify(v)})`
      }
    }
    return null
  } catch {
    return null
  }
}

export const SecurityAuditTool = Tool.define("security_audit", async () => {
  return {
    get description() {
      return DESCRIPTION
    },
    parameters: z.object({
      targetDir: z.string().describe("The absolute path of the directory to analyze (e.g., project root)"),
      type: z.enum(["bun", "npm", "yarn"]).describe("The package manager to use for the audit"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "security_audit",
        patterns: [params.targetDir],
        always: ["*"],
        metadata: {
          targetDir: params.targetDir,
          type: params.type,
        },
      })

      // bun projects are audited via npm audit (bun has no built-in audit command)
      const cmd = params.type === "yarn" ? "yarn audit --json" : "npm audit --json"

      try {
        const { stdout } = await execAsync(cmd, { cwd: params.targetDir })
        const parsed = params.type === "yarn" ? parseYarnVulns(stdout) : parseNpmVulns(stdout)
        return {
          output: `Audit complete. No high-risk vulnerabilities found.\n\n${parsed ?? stdout}`,
          title: `Security Audit: ${params.type}`,
          metadata: { hasVulnerabilities: false },
        }
      } catch (err: any) {
        // npm/yarn exit with non-zero when vulnerabilities are found
        const raw: string = err.stdout || err.stderr || err.message
        const parsed = params.type === "yarn" ? parseYarnVulns(raw) : parseNpmVulns(raw)
        return {
          output: `Vulnerabilities found!\n\n${parsed ?? raw}`,
          title: `Security Audit: ${params.type}`,
          metadata: { hasVulnerabilities: true },
        }
      }
    },
  }
})
