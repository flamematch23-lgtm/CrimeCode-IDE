import z from "zod"
import { Tool } from "./tool"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import { homedir } from "os"
import DESCRIPTION from "./browser.txt"

let browserInstance: { browser: any; page: any } | null = null

function getScreenshotDir(): string {
  const dir = join(homedir(), "OpenCode", "screenshots")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

async function ensureBrowser() {
  if (browserInstance) return browserInstance
  const { chromium } = await import("playwright")
  browserInstance = {
    browser: await chromium.launch({ headless: true }),
    page: null,
  }
  return browserInstance
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.browser.close().catch(() => {})
    browserInstance = null
  }
}

type BrowserResult = {
  title: string
  output: string
  metadata: {
    action: string
    title?: string
    url?: string
    hasScreenshot: boolean
    screenshotPath?: string
    error?: string
  }
}

export const BrowserTool = Tool.define("browser", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().optional().describe("URL to navigate to"),
      action: z
        .enum(["navigate", "screenshot", "content", "close"])
        .optional()
        .default("navigate")
        .describe("Action to perform"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default: 15000)"),
    }),
    async execute(params): Promise<BrowserResult> {
      const timeout = params.timeout ?? 15000
      const action = params.action ?? "navigate"

      if (action === "close") {
        await closeBrowser()
        return {
          title: "Browser Closed",
          output: "Browser session closed successfully.",
          metadata: { action, hasScreenshot: false },
        }
      }

      try {
        await ensureBrowser()
        const inst = browserInstance!

        if (!inst.page) {
          inst.page = await inst.browser.newPage()
        }

        if (action === "navigate" && params.url) {
          await inst.page.goto(params.url, { waitUntil: "networkidle", timeout })
        }

        const title = await inst.page.title()
        const url = inst.page.url()

        if (action === "content") {
          const content = await inst.page.content()
          return {
            title: `Browser: ${title}`,
            output: `## Page Information\n\n**Title**: ${title}\n**URL**: ${url}\n\n## Page Content\n\n\`\`\`\n${content.slice(0, 8000)}${content.length > 8000 ? "\n... [truncated]" : ""}\n\`\`\``,
            metadata: { action, title, url, hasScreenshot: false },
          }
        }

        const screenshot = await inst.page.screenshot({ fullPage: true, type: "png" })
        const filename = `browser_${randomUUID()}.png`
        const filepath = join(getScreenshotDir(), filename)
        writeFileSync(filepath, screenshot)

        return {
          title: `Browser: ${title}`,
          output: `## Browser Screenshot\n\n**Title**: ${title}\n**URL**: ${url}\n\nScreenshot saved to: \`${filepath}\``,
          metadata: { action, title, url, hasScreenshot: true, screenshotPath: filepath },
        }
      } catch (err: any) {
        return {
          title: "Browser Error",
          output: `Browser operation failed: ${err.message}`,
          metadata: { action, hasScreenshot: false, error: err.message },
        }
      }
    },
  }
})
