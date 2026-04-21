import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./clipboard.txt"
import { exec } from "child_process"
import { promisify } from "util"

const run = promisify(exec)

async function read(): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await run("powershell -NoProfile -Command Get-Clipboard")
    return stdout.trimEnd()
  }
  if (process.platform === "darwin") {
    const { stdout } = await run("pbpaste")
    return stdout
  }
  // Linux: try xclip then xsel
  try {
    const { stdout } = await run("xclip -selection clipboard -out")
    return stdout
  } catch {
    const { stdout } = await run("xsel --clipboard --output")
    return stdout
  }
}

async function write(text: string): Promise<void> {
  if (process.platform === "win32") {
    // Use PowerShell pipe to avoid quoting issues
    await run(`powershell -NoProfile -Command "Set-Clipboard -Value @'\n${text}\n'@"`)
    return
  }
  if (process.platform === "darwin") {
    await run(`echo ${JSON.stringify(text)} | pbcopy`)
    return
  }
  try {
    await run(`echo ${JSON.stringify(text)} | xclip -selection clipboard`)
  } catch {
    await run(`echo ${JSON.stringify(text)} | xsel --clipboard --input`)
  }
}

export const ClipboardTool = Tool.define("clipboard", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["read", "write"]).describe("read: get clipboard content, write: set clipboard content"),
      text: z.string().optional().describe("Text to write (required when action is 'write')"),
    }),
    async execute(params, _ctx) {
      if (params.action === "read") {
        let content = ""
        let error = ""
        try {
          content = await read()
        } catch (e: any) {
          error = e.message
        }
        return {
          title: "Clipboard Read",
          output: error ? `Error reading clipboard: ${error}` : content || "(clipboard is empty)",
          metadata: { action: "read", length: content.length, error },
        }
      }

      if (!params.text) {
        return {
          title: "Clipboard Write Error",
          output: "Error: 'text' parameter is required for write action",
          metadata: { action: "write", length: 0, error: "missing text" },
        }
      }

      let error = ""
      try {
        await write(params.text)
      } catch (e: any) {
        error = e.message
      }

      return {
        title: "Clipboard Write",
        output: error
          ? `Error writing to clipboard: ${error}`
          : `Written ${params.text.length} characters to clipboard`,
        metadata: { action: "write", length: params.text.length, error },
      }
    },
  }
})
