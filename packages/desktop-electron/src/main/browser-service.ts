import { initLogging } from "./logging"

const logger = initLogging()

export type BrowserInstance = {
  browser: any
  page: any
}

export type BrowserNavigateResult = {
  success: boolean
  title?: string
  url?: string
  screenshot?: string
  error?: string
}

export class BrowserService {
  private instance: BrowserInstance | null = null
  private launchTimeout: number = 30_000
  private pageTimeout: number = 10_000
  private cleanupInterval: NodeJS.Timeout | null = null

  async acquire(): Promise<BrowserInstance> {
    if (this.instance?.browser && this.instance?.page) {
      return this.instance
    }

    if (this.instance?.browser && !this.instance?.page) {
      this.instance.page = await this.instance.browser.newPage()
      return this.instance
    }

    const { chromium } = await import("playwright")
    this.instance = {
      browser: await chromium.launch({ headless: true }),
      page: null,
    }

    this.setupCleanup()
    logger.log("browser service: browser launched")

    return this.instance
  }

  async navigate(url: string, timeout: number = this.pageTimeout): Promise<BrowserNavigateResult> {
    try {
      const instance = await this.acquire()
      if (!instance.page) {
        instance.page = await instance.browser.newPage()
      }

      await instance.page.goto(url, { waitUntil: "networkidle", timeout })
      const title = await instance.page.title()
      const screenshot = await instance.page.screenshot({ fullPage: true, type: "png" })

      logger.log("browser service: navigated", { url, title })

      return {
        success: true,
        title,
        url,
        screenshot: screenshot.toString("base64"),
      }
    } catch (err: any) {
      logger.error("browser service: navigation failed", { url, error: err.message })
      return { success: false, error: err.message }
    }
  }

  async screenshot(): Promise<{ success: boolean; screenshot?: string; error?: string }> {
    try {
      const instance = await this.acquire()
      if (!instance.page) {
        return { success: false, error: "No active page" }
      }
      const screenshot = await instance.page.screenshot({ fullPage: true, type: "png" })
      return { success: true, screenshot: screenshot.toString("base64") }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async content(): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
    try {
      const instance = await this.acquire()
      if (!instance.page) {
        return { success: false, error: "No active page" }
      }
      const content = await instance.page.content()
      const title = await instance.page.title()
      return { success: true, title, content }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  async previewScreenshot(): Promise<Buffer | null> {
    try {
      const instance = await this.acquire()
      if (!instance.page) return null
      return instance.page.screenshot({ fullPage: true, type: "png" })
    } catch {
      return null
    }
  }

  async close(): Promise<{ success: boolean }> {
    this.clearCleanup()

    if (!this.instance) {
      return { success: true }
    }

    try {
      if (this.instance.browser) {
        await this.instance.browser.close().catch(() => {})
      }
      this.instance = null
      logger.log("browser service: browser closed")
    } catch {}

    return { success: true }
  }

  private setupCleanup(): void {
    if (this.cleanupInterval) return

    this.cleanupInterval = setInterval(async () => {
      if (this.instance?.browser && this.instance?.page) {
        try {
          const pages = this.instance.browser.pages()
          if (pages.length > 1) {
            for (const page of pages.slice(1)) {
              await page.close().catch(() => {})
            }
            logger.log("browser service: cleaned up extra pages")
          }
        } catch {}
      }
    }, 60_000)
  }

  private clearCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

export const browserService = new BrowserService()
