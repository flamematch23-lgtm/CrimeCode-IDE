import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./env_manager.txt"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"

// Parse a .env file into a Record, preserving comments/blank lines as metadata
function parse(src: string): { key: string; value: string; raw: string }[] {
  return src.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return []
    const eq = trimmed.indexOf("=")
    if (eq < 0) return []
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return [{ key, value, raw: line }]
  })
}

function mask(value: string): string {
  if (value.length <= 4) return "****"
  return value.slice(0, 2) + "*".repeat(Math.min(value.length - 4, 8)) + value.slice(-2)
}

function findEnv(dir?: string): string | null {
  const cwd = dir ?? process.cwd()
  for (const name of [".env", ".env.local", ".env.development"]) {
    const p = join(cwd, name)
    if (existsSync(p)) return p
  }
  return null
}

export const EnvManagerTool = Tool.define("env_manager", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      action: z
        .enum(["list", "get", "set", "delete"])
        .describe("list: show all keys, get: read a value, set: add/update a key, delete: remove a key"),
      path: z.string().optional().describe("Path to .env file (auto-detected from cwd if omitted)"),
      key: z.string().optional().describe("Variable name (required for get/set/delete)"),
      value: z.string().optional().describe("Variable value (required for set)"),
      reveal: z.boolean().optional().default(false).describe("Show actual values instead of masked (default: false)"),
    }),
    async execute(params, _ctx) {
      const envPath = params.path ?? findEnv()

      if (
        params.action === "list" ||
        params.action === "get" ||
        params.action === "delete" ||
        params.action === "set"
      ) {
        if (!envPath || !existsSync(envPath)) {
          return {
            title: "Env Manager",
            output: `No .env file found${params.path ? ` at ${params.path}` : " in current directory"}`,
            metadata: { action: params.action, path: envPath ?? "", found: false, count: 0 },
          }
        }
      }

      const src = envPath && existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
      const entries = parse(src)

      if (params.action === "list") {
        const lines = entries.map((e) => {
          const v = params.reveal ? e.value : mask(e.value)
          return `${e.key}=${v}`
        })
        return {
          title: `Env Manager: list ${envPath}`,
          output: lines.length ? lines.join("\n") : "(no variables found)",
          metadata: { action: "list", path: envPath!, count: entries.length, found: true },
        }
      }

      if (params.action === "get") {
        if (!params.key)
          return {
            title: "Env Manager",
            output: "Error: 'key' is required for get",
            metadata: { action: "get", path: envPath ?? "", found: false, count: 0 },
          }
        const entry = entries.find((e) => e.key === params.key)
        if (!entry)
          return {
            title: `Env: ${params.key}`,
            output: `Key '${params.key}' not found`,
            metadata: { action: "get", path: envPath ?? "", found: false, count: 0 },
          }
        const v = params.reveal ? entry.value : mask(entry.value)
        return {
          title: `Env: ${params.key}`,
          output: `${params.key}=${v}`,
          metadata: { action: "get", path: envPath!, found: true, count: 0 },
        }
      }

      if (params.action === "set") {
        if (!params.key || params.value === undefined)
          return {
            title: "Env Manager",
            output: "Error: 'key' and 'value' are required for set",
            metadata: { action: "set", path: envPath ?? "", found: false, count: 0 },
          }

        const targetPath = envPath ?? join(process.cwd(), ".env")
        const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : ""
        const lines = existing.split(/\r?\n/)
        const idx = lines.findIndex((l) => l.trim().startsWith(`${params.key}=`))
        const newLine = `${params.key}=${params.value}`

        if (idx >= 0) {
          lines[idx] = newLine
        } else {
          if (lines.at(-1) === "") lines[lines.length - 1] = newLine
          else lines.push(newLine)
        }

        writeFileSync(targetPath, lines.join("\n"), "utf8")
        const op = idx >= 0 ? "updated" : "added"
        return {
          title: `Env: ${params.key} ${op}`,
          output: `${op} ${params.key} in ${targetPath}`,
          metadata: { action: "set", path: targetPath, found: true, count: 0 },
        }
      }

      // delete
      if (!params.key)
        return {
          title: "Env Manager",
          output: "Error: 'key' is required for delete",
          metadata: { action: "delete", path: envPath ?? "", found: false, count: 0 },
        }

      const lines = src.split(/\r?\n/)
      const next = lines.filter((l) => !l.trim().startsWith(`${params.key}=`))
      if (next.length === lines.length)
        return {
          title: `Env: ${params.key}`,
          output: `Key '${params.key}' not found`,
          metadata: { action: "delete", path: envPath!, found: false, count: 0 },
        }

      writeFileSync(envPath!, next.join("\n"), "utf8")
      return {
        title: `Env: deleted ${params.key}`,
        output: `Deleted ${params.key} from ${envPath}`,
        metadata: { action: "delete", path: envPath!, found: true, count: 0 },
      }
    },
  }
})
