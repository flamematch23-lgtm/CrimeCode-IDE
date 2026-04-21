import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Send system notifications with optional actions"

const PARAMETERS = z.object({
  title: z.string().describe("Notification title"),
  body: z.string().optional().describe("Notification body text"),
  silent: z.boolean().optional().describe("Silent notification (no sound)"),
  urgency: z.enum(["low", "normal", "critical"]).optional().describe("Urgency level"),
  actions: z
    .array(z.object({ label: z.string(), id: z.string() }))
    .optional()
    .describe("Quick actions"),
})

export const NotificationTool = Tool.define("notification", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    let sent = false

    if (process.platform === "win32") {
      try {
        const { execSync } = await import("child_process")
        const escapedTitle = params.title.replace(/'/g, "''")
        const escapedBody = (params.body || "").replace(/'/g, "''")
        const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('${escapedBody}', '${escapedTitle}', 'OK', 'Information')
`
        execSync(`powershell -Command "${script}"`, { encoding: "utf-8", timeout: 5000 })
        sent = true
      } catch {}
    } else if (process.platform === "darwin") {
      try {
        const { execSync } = await import("child_process")
        const cmd = `osascript -e 'display notification "${params.body || ""}" with title "${params.title}"`
        execSync(cmd, { timeout: 5000 })
        sent = true
      } catch {}
    } else {
      try {
        const { execSync } = await import("child_process")
        const body = params.body ? `"${params.body}"` : ""
        execSync(`notify-send "${params.title}" ${body}`, { timeout: 5000 })
        sent = true
      } catch {}
    }

    return {
      title: "Notification",
      output: `## Notification\n\n**Title**: ${params.title}\n**Body**: ${params.body || "(none)"}\n**Status**: ${sent ? "Sent" : "Failed - platform not supported"}`,
      metadata: { action: "notification", sent, title: params.title },
    }
  },
})
