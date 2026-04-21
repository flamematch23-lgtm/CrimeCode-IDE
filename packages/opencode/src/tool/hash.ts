import { Tool } from "./tool"
import z from "zod"
import { createHash } from "crypto"
import { readFileSync } from "fs"

const DESCRIPTION = "Calculate cryptographic hashes of files or strings"

const PARAMETERS = z.object({
  input: z.string().describe("File path or string to hash"),
  algorithm: z.enum(["md5", "sha1", "sha256", "sha512"]).optional().describe("Hash algorithm (default: sha256)"),
  isFile: z.boolean().optional().describe("Treat input as file path (default: false)"),
})

export const HashTool = Tool.define("hash", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const algorithm = params.algorithm || "sha256"
    let hash = ""
    let inputType = "string"
    let size = 0

    try {
      if (params.isFile) {
        inputType = "file"
        const fileBuffer = readFileSync(params.input)
        size = fileBuffer.length
        hash = createHash(algorithm).update(fileBuffer).digest("hex")
      } else {
        hash = createHash(algorithm).update(params.input, "utf8").digest("hex")
        size = Buffer.byteLength(params.input, "utf8")
      }
    } catch (err: any) {
      return {
        title: "Hash Calculator",
        output: `Error calculating hash: ${err.message}`,
        metadata: { action: "hash", result: "error", algorithm, hash: "" },
      }
    }

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    return {
      title: "Hash Calculator",
      output: `## Hash Calculator\n\n**Algorithm**: ${algorithm.toUpperCase()}
**Input Type**: ${inputType}
**Input Size**: ${formatSize(size)}\n\n**Hash**:\n\`\`\`\n${hash}\n\`\`\`\n\nVerify with:\n\`\`\`bash\necho -n "${params.isFile ? "" : params.input.replace(/"/g, '\\"')}" | ${algorithm}sum\n# or\n${algorithm}sum ${params.isFile ? params.input : "<file>"}\n\`\`\``,
      metadata: { action: "hash", result: "success", algorithm, hash },
    }
  },
})
