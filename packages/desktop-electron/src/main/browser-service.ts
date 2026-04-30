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

/** Information about a Chrome/Edge instance discovered via DevTools Protocol. */
export type ConnectedBrowserInfo = {
  id: string
  label: string
  url: string
  port: number
}

// Chrome/Edge default DevTools ports + a small range for users who launched
// `chrome --remote-debugging-port=9223` etc. Probing these is cheap and only
// happens on demand from the settings panel.
const DEVTOOLS_PORT_CANDIDATES = [9222, 9223, 9224, 9225, 9229, 9230]
const DEVTOOLS_DISCOVERY_TIMEOUT_MS = 600

export class BrowserService {
  private instance: BrowserInstance | null = null
  private launchTimeout: number = 30_000
  private pageTimeout: number = 10_000
  private cleanupInterval: NodeJS.Timeout | null = null
  /** When true, browser-tool calls bypass the per-action permission prompt.
   *  The renderer mirrors this in the Automation settings page. */
  private allowAll = false

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

  // ─────────────────────────────────────────────────────────────────────
  // Automation panel API — surfaced to the renderer through IPC.
  // Keep this section side-effect-free apart from logging so it can run
  // even when the automation toggle is OFF (the settings page reads the
  // value before flipping it).
  // ─────────────────────────────────────────────────────────────────────

  /** Returns whether Claude is allowed to perform any browser action without
   *  a per-action confirmation. Defaults to false on a fresh install. */
  isAllowAll(): boolean {
    return this.allowAll
  }

  /** Set the allow-all flag. Persistence is handled by the caller (the IPC
   *  handler) via the electron-store layer, so this only updates the runtime
   *  flag — the next process boot will re-apply the persisted value. */
  setAllowAll(value: boolean): void {
    this.allowAll = !!value
    logger.log("browser service: allow-all toggled", { value: this.allowAll })
  }

  /**
   * Discover Chrome/Edge instances exposing the DevTools Protocol on a known
   * debug port. Returns an empty array (never throws) so the settings UI can
   * always render a stable list regardless of OS/network state.
   *
   * The probe is intentionally narrow: we only check `localhost` to avoid
   * leaking discovery traffic onto the network, and we cap each request at
   * ~600ms so an unresponsive port can't block the panel.
   */
  async listConnectedBrowsers(): Promise<ConnectedBrowserInfo[]> {
    const out: ConnectedBrowserInfo[] = []

    await Promise.all(
      DEVTOOLS_PORT_CANDIDATES.map(async (port) => {
        const targets = await this.fetchDevtoolsTargets(port)
        for (const t of targets) {
          out.push({
            id: t.id ?? `${port}-${t.url ?? "unknown"}`,
            label: t.title?.trim() ? t.title : `Chrome :${port}`,
            url: t.url ?? "",
            port,
          })
        }
      }),
    )

    return out
  }

  private async fetchDevtoolsTargets(
    port: number,
  ): Promise<Array<{ id?: string; title?: string; url?: string; type?: string }>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEVTOOLS_DISCOVERY_TIMEOUT_MS)
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: controller.signal,
        // Avoid sending cookies or auth headers — the DevTools endpoint is
        // sensitive (it can drive arbitrary tabs) and we don't need them.
        credentials: "omit",
      })
      if (!resp.ok) return []
      const data = (await resp.json()) as Array<{ id?: string; title?: string; url?: string; type?: string }>
      // Filter out devtools / service-worker entries — only show real pages.
      return Array.isArray(data) ? data.filter((t) => t.type === "page") : []
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

export const browserService = new BrowserService()
