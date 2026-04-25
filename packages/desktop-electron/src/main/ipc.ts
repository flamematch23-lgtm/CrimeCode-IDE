import { execFile, spawn } from "node:child_process"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { BrowserWindow, Menu, Notification, app, clipboard, desktopCapturer, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, TitlebarTheme, WslConfig } from "../preload/types"
import { browserService } from "./browser-service"
import { getStore } from "./store"
import { windowStateService } from "./window-state-service"
import { setTitlebar, snapWindow } from "./windows"
import {
  licenseService,
  adminSession,
  adminGrant,
  adminRevoke,
  adminExtendTrial,
  adminReset,
  VALID_INTERVALS,
} from "./license"
import type { ProInterval } from "./license"
import { authService } from "./auth"
import { toggleProxy } from "./cli"
// CHECKOUT_BASE_URL retained in constants for retrocompat; checkout now opens
// a Telegram DM to one of the support contacts for crypto payments.

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

type Deps = {
  killSidecar: () => void
  installCli: () => Promise<string>
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  getUpdateState: () => { ready: boolean; version?: string; notes?: string; downloadedAt?: number }
  setBackgroundColor: (color: string) => void
}

const assertValidInterval = (value: unknown): ProInterval => {
  if (typeof value === "string" && VALID_INTERVALS.has(value)) return value as ProInterval
  throw new Error(`Invalid interval: ${String(value)}`)
}

const assertValidTrialDays = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid days: ${String(value)}`)
  }
  if (Math.abs(value) > 365 * 100) {
    throw new Error(`days out of range: ${value}`)
  }
  return value
}

function isPowershell(app: string) {
  const name = app.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  return name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe"
}

function resolveDir(path: string) {
  try {
    if (statSync(path).isDirectory()) return path
  } catch {}
  return dirname(path)
}

export function registerIpcHandlers(deps: Deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("install-cli", () => deps.installCli())
  ipcMain.handle(
    "toggle-proxy",
    (
      _event: IpcMainInvokeEvent,
      enabled: boolean,
      target?: string,
      auth?: string,
      proxyUrl?: string,
      username?: string,
    ) => toggleProxy(enabled, target, auth, proxyUrl, username),
  )
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("get-update-state", () => deps.getUpdateState())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    const store = getStore(name)
    const value = store.get(key)
    if (value === undefined || value === null) return null
    return typeof value === "string" ? value : JSON.stringify(value)
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)

    if (process.platform === "win32" && isPowershell(app)) {
      const dir = resolveDir(path)
      spawn(app, ["-NoExit"], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
      }).unref()
      return
    }

    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => event.sender.setZoomFactor(factor))
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })

  // Enhancement 3: Native context menus
  ipcMain.handle(
    "show-context-menu",
    (event: IpcMainInvokeEvent, items: Array<{ id: string; label: string; type?: string; enabled?: boolean }>) => {
      return new Promise<string | null>((resolve) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return resolve(null)
        const template = items.map((item) => {
          if (item.type === "separator") return { type: "separator" as const }
          return {
            label: item.label,
            enabled: item.enabled !== false,
            click: () => resolve(item.id),
          }
        })
        const menu = Menu.buildFromTemplate(template)
        menu.popup({ window: win, callback: () => resolve(null) })
      })
    },
  )

  // Enhancement 5: Write file (for session export)
  ipcMain.handle("write-file", (_event: IpcMainInvokeEvent, path: string, content: string) => {
    writeFileSync(path, content, "utf-8")
  })

  // Enhancement 8: Forward update progress to renderer
  // Track one handler per sender id to prevent listener leaks on re-subscribe
  const progressHandlers = new Map<number, (info: { percent: number }) => void>()
  ipcMain.handle("subscribe-update-progress", (event: IpcMainInvokeEvent) => {
    const sender = event.sender
    const { autoUpdater } = require("electron-updater") as typeof import("electron-updater")
    // Remove any previous handler for this sender before adding a new one
    const prev = progressHandlers.get(sender.id)
    if (prev) autoUpdater.removeListener("download-progress", prev)
    const handler = (info: { percent: number }) => {
      if (!sender.isDestroyed()) sender.send("update-progress", info.percent)
    }
    progressHandlers.set(sender.id, handler)
    autoUpdater.on("download-progress", handler)
    sender.once("destroyed", () => {
      autoUpdater.removeListener("download-progress", handler)
      progressHandlers.delete(sender.id)
    })
  })

  // Browser tool - integrated with AI Agent system
  ipcMain.handle("browser-navigate", async (_event: IpcMainInvokeEvent, url: string, timeout: number = 10000) => {
    return browserService.navigate(url, timeout)
  })

  ipcMain.handle("browser-screenshot", async () => {
    return browserService.screenshot()
  })

  ipcMain.handle("browser-content", async () => {
    return browserService.content()
  })

  ipcMain.handle("browser-close", async () => {
    return browserService.close()
  })

  ipcMain.handle("browser-preview-screenshot", async () => {
    const screenshot = await browserService.previewScreenshot()
    return screenshot
  })

  // Update browser preview panel URL in renderer
  ipcMain.handle("browser-preview-navigate", (event: IpcMainInvokeEvent, url: string) => {
    event.sender.send("browser-preview-navigate", url)
  })

  // Window management IPC handlers
  ipcMain.handle("window-minimize", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.handle("window-maximize", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle("window-close", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.close()
  })

  ipcMain.handle("window-is-maximized", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })

  ipcMain.handle(
    "window-snap",
    (event: IpcMainInvokeEvent, position: "left" | "right" | "top" | "bottom" | "center") => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) snapWindow(win, position)
    },
  )

  ipcMain.handle("window-set-always-on-top", (event: IpcMainInvokeEvent, flag: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.setAlwaysOnTop(flag)
  })

  ipcMain.handle("window-is-always-on-top", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isAlwaysOnTop() ?? false
  })

  ipcMain.handle("window-state-get", (_event: IpcMainInvokeEvent, key: string) => {
    const windowId = BrowserWindow.fromWebContents(_event.sender)?.id.toString() ?? "default"
    return windowStateService.get(windowId, key)
  })

  ipcMain.handle("window-state-set", (_event: IpcMainInvokeEvent, key: string, value: any) => {
    const windowId = BrowserWindow.fromWebContents(_event.sender)?.id.toString() ?? "default"
    windowStateService.set(windowId, key, value)
  })

  // Screen sharing: enumerate desktop sources (screens + windows) for picker UI.
  ipcMain.handle(
    "get-screen-sources",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { types?: Array<"screen" | "window">; thumbnail?: { width: number; height: number } },
    ) => {
      const types = opts?.types ?? ["screen", "window"]
      const thumb = opts?.thumbnail ?? { width: 320, height: 180 }
      const sources = await desktopCapturer.getSources({ types, thumbnailSize: thumb })
      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.id.startsWith("screen") ? "screen" : "window",
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
      }))
    },
  )

  ipcMain.handle("license-get", () => licenseService.get())

  ipcMain.handle("license-start-trial", () => {
    return licenseService.startTrial()
  })

  ipcMain.handle("license-open-checkout", (_event: IpcMainInvokeEvent, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") {
      throw new Error("Invalid checkout payload")
    }
    const raw = rawPayload as Record<string, unknown>
    const interval = assertValidInterval(raw.interval)
    const contact = raw.contact
    if (contact !== "opcrime" && contact !== "jollyfraud") {
      throw new Error("Invalid contact")
    }
    const handle = contact === "opcrime" ? "OpCrime1312" : "JollyFraud"
    const message =
      `Hi! I want to purchase CrimeCode Pro - ${interval} plan via crypto payment. ` + `Please provide details.`
    const url = `https://t.me/${handle}?text=${encodeURIComponent(message)}`
    void shell.openExternal(url)
  })

  ipcMain.handle("license-activate-token", (_event: IpcMainInvokeEvent, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid activate payload")
    const raw = payload as Record<string, unknown>
    const interval = assertValidInterval(raw.interval)
    const token = typeof raw.token === "string" && raw.token.length > 0 ? raw.token : null
    if (!token) throw new Error("Missing or invalid token")
    return licenseService.activateFromToken({ interval, token })
  })

  // ── Account / sign-in (Telegram magic-link via @CrimeCodeSub_bot) ──
  ipcMain.handle("account-get", () => authService.get())

  ipcMain.handle("account-start-signin", async () => {
    return authService.startSignIn()
  })

  ipcMain.handle("account-poll-signin", async (_e, pin: string) => {
    if (typeof pin !== "string" || pin.length === 0) throw new Error("Invalid PIN")
    return authService.pollSignIn(pin)
  })

  ipcMain.handle("account-logout", () => authService.logout())

  ipcMain.handle("account-sync-get", async (_e, key: string) => {
    if (typeof key !== "string") throw new Error("Invalid sync key")
    const r = await authService.fetch(`/license/sync/${encodeURIComponent(key)}`)
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`sync get failed: ${r.status}`)
    return await r.json()
  })

  ipcMain.handle("account-sync-put", async (_e, key: string, value: string) => {
    if (typeof key !== "string" || typeof value !== "string") throw new Error("Invalid sync args")
    const r = await authService.fetch(`/license/sync/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    })
    if (!r.ok) throw new Error(`sync put failed: ${r.status}`)
    return await r.json()
  })

  // ── Teams ──
  const teamJson = async (path: string, init?: RequestInit) => {
    const r = await authService.fetch(path, init)
    const text = await r.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!r.ok) {
      const msg =
        typeof body === "object" && body && "error" in body ? (body as { error: string }).error : `${r.status}`
      throw new Error(msg)
    }
    return body
  }

  ipcMain.handle("teams-list", () => teamJson(`/license/teams`))
  ipcMain.handle("teams-create", (_e, name: string) =>
    teamJson(`/license/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  )
  ipcMain.handle("teams-detail", (_e, teamId: string) => teamJson(`/license/teams/${encodeURIComponent(teamId)}`))
  ipcMain.handle("teams-rename", (_e, teamId: string, name: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  )
  ipcMain.handle("teams-delete", (_e, teamId: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" }),
  )
  ipcMain.handle("teams-add-member", (_e, teamId: string, identifier: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier }),
    }),
  )
  ipcMain.handle("teams-remove-member", (_e, teamId: string, customerId: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(customerId)}`, {
      method: "DELETE",
    }),
  )
  ipcMain.handle("teams-set-member-role", (_e, teamId: string, customerId: string, role: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(customerId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }),
  )
  ipcMain.handle("teams-cancel-invite", (_e, teamId: string, inviteId: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`, {
      method: "DELETE",
    }),
  )
  ipcMain.handle("teams-list-sessions", (_e, teamId: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/sessions`),
  )
  ipcMain.handle("teams-publish-session", (_e, teamId: string, title: string, state: unknown) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, state }),
    }),
  )
  ipcMain.handle("teams-heartbeat-session", (_e, teamId: string, sid: string, state: unknown) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sid)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    }),
  )
  ipcMain.handle("teams-end-session", (_e, teamId: string, sid: string) =>
    teamJson(`/license/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" }),
  )

  // ── Project: create new (folder) ──
  ipcMain.handle("project-create", async (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("No window")
    const result = await dialog.showSaveDialog(win, {
      title: "New Project",
      buttonLabel: "Create",
      properties: ["showOverwriteConfirmation", "createDirectory", "showHiddenFiles"],
      defaultPath: app.getPath("documents"),
    })
    if (result.canceled || !result.filePath) return null
    try {
      mkdirSync(result.filePath, { recursive: true })
    } catch (err) {
      throw new Error(`Could not create directory: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { directory: result.filePath }
  })

  ipcMain.handle("admin-status", () => ({ unlocked: adminSession.isUnlocked() }))

  ipcMain.handle("admin-unlock", async (_event: IpcMainInvokeEvent, passphrase: string) => {
    const ok = await adminSession.unlock(passphrase)
    return { unlocked: ok }
  })

  ipcMain.handle("admin-lock", () => {
    adminSession.lock()
    return { unlocked: adminSession.isUnlocked() }
  })

  ipcMain.handle("admin-grant", (_event: IpcMainInvokeEvent, rawInterval: unknown) => {
    return adminGrant(assertValidInterval(rawInterval))
  })

  ipcMain.handle("admin-revoke", () => {
    return adminRevoke()
  })

  ipcMain.handle("admin-extend-trial", (_event: IpcMainInvokeEvent, rawDays: unknown) => {
    return adminExtendTrial(assertValidTrialDays(rawDays))
  })

  ipcMain.handle("admin-reset", () => {
    return adminReset()
  })
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
