import { Tool } from "./tool"
import z from "zod"
import { Glob } from "../util/glob"

const DESCRIPTION = "Search for files by name pattern with advanced filtering options"

const PARAMETERS = z.object({
  pattern: z.string().describe("Glob pattern to match files (e.g., '*.ts', '**/*.js')"),
  directory: z.string().optional().describe("Directory to search in (defaults to current directory)"),
  maxResults: z.number().optional().describe("Maximum number of results (default: 50)"),
})

export const FileSearchTool = Tool.define("file_search", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx) {
    const dir = params.directory || ctx.extra?.directory || process.cwd()
    const max = params.maxResults || 50

    const matches = Glob.scanSync(params.pattern, {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    })

    const limited = matches.slice(0, max)
    const truncated = matches.length > max

    let output = `## File Search Results\n\n**Pattern**: ${params.pattern}
**Path**: ${dir}
**Found**: ${matches.length} file(s)`
    if (truncated) output += ` (showing first ${max})`

    if (limited.length === 0) {
      output += "\n\nNo files found matching the pattern."
      return {
        title: "File Search",
        output,
        metadata: { action: "file_search", count: 0, truncated: false },
      }
    }

    output += "\n\n```\n"
    for (const file of limited) {
      const relative = file.replace(dir, ".").replace(/^[\\\/]/, "")
      output += relative + "\n"
    }
    output += "```"

    return {
      title: "File Search",
      output,
      metadata: { action: "file_search", count: limited.length, truncated },
    }
  },
})
