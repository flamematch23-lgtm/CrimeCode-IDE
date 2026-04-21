import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./code_runner.txt"
import { spawn } from "child_process"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, unlinkSync } from "fs"

const LANGS = ["javascript", "typescript", "python", "bash", "sh"] as const

function cmd(lang: (typeof LANGS)[number], file: string): [string, string[]] {
  switch (lang) {
    case "javascript":
      return ["node", [file]]
    case "typescript":
      return ["npx", ["tsx", file]]
    case "python":
      return ["python3", [file]]
    case "bash":
    case "sh":
      return ["bash", [file]]
  }
}

function ext(lang: (typeof LANGS)[number]): string {
  switch (lang) {
    case "javascript":
      return "js"
    case "typescript":
      return "ts"
    case "python":
      return "py"
    case "bash":
    case "sh":
      return "sh"
  }
}

export const CodeRunnerTool = Tool.define("code_runner", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      language: z.enum(LANGS).describe("Programming language to execute"),
      code: z.string().describe("Code snippet to run"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "code_runner",
        patterns: [params.language],
        always: [],
        metadata: {
          language: params.language,
          preview: params.code.slice(0, 120),
        },
      })

      const timeout = params.timeout ?? 10000
      const file = join(tmpdir(), `opencode_run_${Date.now()}.${ext(params.language)}`)

      try {
        writeFileSync(file, params.code, "utf8")
        const [bin, args] = cmd(params.language, file)

        const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
          const proc = spawn(bin, args, { timeout, shell: false })
          const out: string[] = []
          const err: string[] = []
          proc.stdout?.on("data", (d: Buffer) => out.push(d.toString()))
          proc.stderr?.on("data", (d: Buffer) => err.push(d.toString()))
          proc.on("close", (code) => resolve({ stdout: out.join(""), stderr: err.join(""), code }))
          proc.on("error", (e) => resolve({ stdout: "", stderr: e.message, code: 1 }))
        })

        const lines: string[] = []
        if (result.stdout) lines.push(`stdout:\n${result.stdout}`)
        if (result.stderr) lines.push(`stderr:\n${result.stderr}`)
        lines.push(`exit code: ${result.code ?? "unknown"}`)

        return {
          title: `Code Runner (${params.language})`,
          output: lines.join("\n\n"),
          metadata: { language: params.language, exitCode: result.code },
        }
      } finally {
        try {
          unlinkSync(file)
        } catch {}
      }
    },
  }
})
