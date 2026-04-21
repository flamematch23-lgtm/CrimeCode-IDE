import { Tool } from "./tool"
import z from "zod"
import { existsSync, mkdirSync, copyFileSync, renameSync, unlinkSync, readdirSync, statSync } from "fs"
import { join, dirname, basename, extname } from "path"

const DESCRIPTION = "Advanced file operations: copy, move, delete, create directories, and list directory contents"

const PARAMETERS = z.object({
  action: z.enum(["copy", "move", "delete", "mkdir", "list", "info"]).describe("File operation to perform"),
  source: z.string().optional().describe("Source path"),
  destination: z.string().optional().describe("Destination path (for copy/move)"),
  recursive: z.boolean().optional().describe("Recursive operation (for list/delete)"),
  pattern: z.string().optional().describe("File pattern filter (for list)"),
})

export const FileOpsTool = Tool.define("file_ops", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    let output = ""
    let result = "success"

    try {
      switch (params.action) {
        case "copy": {
          if (!params.source || !params.destination) {
            return {
              title: "File Operations",
              output: "Error: source and destination are required for copy",
              metadata: { action: "file_ops", type: "copy", result: "error" },
            }
          }
          if (!existsSync(params.source)) {
            return {
              title: "File Operations",
              output: `Error: source path does not exist: ${params.source}`,
              metadata: { action: "file_ops", type: "copy", result: "error" },
            }
          }
          const destDir = dirname(params.destination)
          if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true })
          }
          copyFileSync(params.source, params.destination)
          output = `Copied: ${params.source} -> ${params.destination}`
          break
        }

        case "move": {
          if (!params.source || !params.destination) {
            return {
              title: "File Operations",
              output: "Error: source and destination are required for move",
              metadata: { action: "file_ops", type: "move", result: "error" },
            }
          }
          if (!existsSync(params.source)) {
            return {
              title: "File Operations",
              output: `Error: source path does not exist: ${params.source}`,
              metadata: { action: "file_ops", type: "move", result: "error" },
            }
          }
          const destDir = dirname(params.destination)
          if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true })
          }
          renameSync(params.source, params.destination)
          output = `Moved: ${params.source} -> ${params.destination}`
          break
        }

        case "delete": {
          if (!params.source) {
            return {
              title: "File Operations",
              output: "Error: source is required for delete",
              metadata: { action: "file_ops", type: "delete", result: "error" },
            }
          }
          if (!existsSync(params.source)) {
            return {
              title: "File Operations",
              output: `Error: path does not exist: ${params.source}`,
              metadata: { action: "file_ops", type: "delete", result: "error" },
            }
          }
          const stat = statSync(params.source)
          if (stat.isDirectory()) {
            if (params.recursive) {
              const { rmSync } = await import("fs")
              rmSync(params.source, { recursive: true, force: true })
            } else {
              const { rmdirSync } = await import("fs")
              rmdirSync(params.source)
            }
          } else {
            unlinkSync(params.source)
          }
          output = `Deleted: ${params.source}`
          break
        }

        case "mkdir": {
          if (!params.source) {
            return {
              title: "File Operations",
              output: "Error: source (directory path) is required for mkdir",
              metadata: { action: "file_ops", type: "mkdir", result: "error" },
            }
          }
          if (existsSync(params.source)) {
            output = `Directory already exists: ${params.source}`
          } else {
            mkdirSync(params.source, { recursive: true })
            output = `Created directory: ${params.source}`
          }
          break
        }

        case "list": {
          if (!params.source) {
            return {
              title: "File Operations",
              output: "Error: source (directory path) is required for list",
              metadata: { action: "file_ops", type: "list", result: "error" },
            }
          }
          if (!existsSync(params.source)) {
            return {
              title: "File Operations",
              output: `Error: directory does not exist: ${params.source}`,
              metadata: { action: "file_ops", type: "list", result: "error" },
            }
          }
          const entries = readdirSync(params.source)
          let filtered = entries
          if (params.pattern) {
            const regex = new RegExp(params.pattern.replace(/\*/g, ".*"))
            filtered = entries.filter((f) => regex.test(f))
          }
          output = `## Directory Contents\n\n**Path**: ${params.source}\n**Items**: ${filtered.length}\n\n`
          for (const entry of filtered) {
            const fullPath = join(params.source, entry)
            try {
              const stat = statSync(fullPath)
              const type = stat.isDirectory() ? "[DIR]" : `[FILE:${extname(entry).slice(1) || "none"}]`
              const size = stat.isDirectory() ? "-" : formatBytes(stat.size)
              output += `${type} ${entry.padEnd(40)} ${size}\n`
            } catch {
              output += `[???] ${entry}\n`
            }
          }
          break
        }

        case "info": {
          if (!params.source) {
            return {
              title: "File Operations",
              output: "Error: source is required for info",
              metadata: { action: "file_ops", type: "info", result: "error" },
            }
          }
          if (!existsSync(params.source)) {
            return {
              title: "File Operations",
              output: `Error: path does not exist: ${params.source}`,
              metadata: { action: "file_ops", type: "info", result: "error" },
            }
          }
          const stat = statSync(params.source)
          const info = {
            path: params.source,
            name: basename(params.source),
            type: stat.isDirectory() ? "Directory" : "File",
            size: formatBytes(stat.size),
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
            permissions: stat.mode.toString(8).slice(-3),
          }
          output = `## File Info\n\n`
          for (const [key, value] of Object.entries(info)) {
            output += `- **${key}**: ${value}\n`
          }
          break
        }
      }
    } catch (err: any) {
      output = `Error: ${err.message}`
      result = "error"
    }

    return {
      title: `File Operations: ${params.action}`,
      output,
      metadata: { action: "file_ops", type: params.action, result },
    }
  },
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}
