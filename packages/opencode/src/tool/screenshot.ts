import { Tool } from "./tool"
import z from "zod"
import { execSync } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import { homedir } from "os"
import { Automation } from "../automation"

const DESCRIPTION = "Take screenshots of the entire screen or a specific region"

function getScreenshotDir(): string {
  const dir = join(homedir(), "OpenCode", "screenshots")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export const ScreenshotTool = Tool.define("screenshot", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(["full", "region", "save"]).describe("Screenshot action"),
    path: z.string().optional().describe("Custom save path for the screenshot"),
    region: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe("Region to capture (for region action)"),
  }),
  async execute(params) {
    // Capturing the screen is the canonical computer-use capability. Refuse
    // to run when the master toggle in Settings → Automation is off, so an
    // agent can't quietly take screenshots without the user opting in.
    if (!Automation.computerUseEnabled()) {
      return {
        title: "Screenshot",
        output:
          "Computer use is disabled. Enable “Uso del computer (Beta)” in Settings → Automation to allow this tool.",
        metadata: { action: "screenshot", type: params.action, result: "disabled", screenshotPath: "" },
      }
    }

    const isWin = process.platform === "win32"
    const tmpDir = getScreenshotDir()
    const filename = `screenshot_${randomUUID()}.png`
    const outputPath = params.path || join(tmpDir, filename)
    let screenshotPath = ""

    try {
      if (isWin) {
        const regionPart =
          params.action === "region" && params.region
            ? `$region = New-Object System.Drawing.Rectangle(${params.region.x}, ${params.region.y}, ${params.region.width}, ${params.region.height}); $bw = $region.Width; $bh = $region.Height; $ox = $region.Location.X; $oy = $region.Location.Y`
            : `$bw = $screen.Width; $bh = $screen.Height; $ox = 0; $oy = 0`

        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
${regionPart}
$bitmap = New-Object System.Drawing.Bitmap($bw, $bh)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($ox, $oy, 0, 0, (New-Object System.Drawing.Size($bw, $bh)))
$bitmap.Save('${outputPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output 'SUCCESS'
`
        const result = execSync(`powershell -Command "${script}"`, { encoding: "utf-8", timeout: 10000 })
        if (!result.includes("SUCCESS")) {
          return {
            title: "Screenshot",
            output: `Failed to capture screenshot: ${result}`,
            metadata: { action: "screenshot", type: params.action, result: "error", screenshotPath: "" },
          }
        }
        screenshotPath = outputPath
      } else {
        const region = params.region
          ? `-a ${params.region.x},${params.region.y},${params.region.width},${params.region.height}`
          : ""
        execSync(`gnome-screenshot -f "${outputPath}" ${region}`, { timeout: 10000 })
        screenshotPath = outputPath
      }

      if (!existsSync(screenshotPath)) {
        return {
          title: "Screenshot",
          output: "Screenshot was created but file not found",
          metadata: { action: "screenshot", type: params.action, result: "error", screenshotPath: "" },
        }
      }

      return {
        title: "Screenshot",
        output: `## Screenshot Captured\n\n**Type**: ${params.action}${params.region ? `\n**Region**: ${params.region.x}x${params.region.y} ${params.region.width}x${params.region.height}` : `\n**Area**: Full Screen`}\n\nScreenshot saved to: \`${screenshotPath}\``,
        metadata: { action: "screenshot", type: params.action, result: "success", screenshotPath },
      }
    } catch (err: any) {
      return {
        title: "Screenshot",
        output: `Error capturing screenshot: ${err.message}`,
        metadata: { action: "screenshot", type: params.action, result: "error", screenshotPath: "" },
      }
    }
  },
})
