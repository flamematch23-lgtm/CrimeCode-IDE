import z from "zod"
import { Tool } from "./tool"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import { homedir } from "os"
import DESCRIPTION from "./browser_sandbox.txt"

function getScreenshotDir(): string {
  const dir = join(homedir(), "OpenCode", "screenshots")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export const BrowserSandboxTool = Tool.define("browser_sandbox", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().describe("The URL to visit (e.g., http://localhost:3000)"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "browser_sandbox",
        patterns: [params.url],
        always: ["*"],
        metadata: {
          url: params.url,
          timeout: params.timeout,
        },
      })

      const ms = params.timeout || 10000
      let browser
      try {
        const { chromium } = await import("playwright")
        browser = await chromium.launch({ headless: true })
        const page = await browser.newPage()

        const logs: string[] = []
        const errors: string[] = []

        page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
        page.on("pageerror", (err) => errors.push(`[UNHANDLED ERROR] ${err.message}`))
        page.on("requestfailed", (request) =>
          errors.push(`[NETWORK ERROR] ${request.url()} - ${request.failure()?.errorText}`),
        )

        try {
          await page.goto(params.url, { waitUntil: "networkidle", timeout: ms })
        } catch (e: any) {
          errors.push(`[NAVIGATION ERROR] ${e.message}`)
        }

        await page.waitForTimeout(2000).catch(() => {})

        const title = await page.title().catch(() => "Unknown Title")

        let screenshotInfo = ""
        try {
          const buf = await page.screenshot({ fullPage: true, type: "png" })
          const filename = `sandbox_${randomUUID()}.png`
          const filepath = join(getScreenshotDir(), filename)
          writeFileSync(filepath, buf)
          screenshotInfo = `\n\nScreenshot saved to: \`${filepath}\``
        } catch {
          screenshotInfo = "\n\nScreenshot: [capture failed]"
        }

        return {
          output: `Page Title: ${title}\n\nConsole Logs:\n${logs.join("\n")}\n\nErrors:\n${errors.join("\n") || "No errors detected."}${screenshotInfo}`,
          title: `Browser Sandbox: ${params.url}`,
          metadata: {
            logsCount: logs.length,
            errorsCount: errors.length,
            hasScreenshot: screenshotInfo.includes("saved to"),
            screenshotPath: screenshotInfo.includes("saved to") ? screenshotInfo.match(/`(.*?)`/)?.[1] : undefined,
          },
        }
      } catch (err: any) {
        return {
          output: `Failed to launch browser sandbox: ${err.message}\nMake sure Playwright browsers are installed ('npx playwright install').`,
          title: `Browser Sandbox Error`,
          metadata: { logsCount: 0, errorsCount: 1, hasScreenshot: false, screenshotPath: "" },
        }
      } finally {
        if (browser) {
          await browser.close().catch(() => {})
        }
      }
    },
  }
})
