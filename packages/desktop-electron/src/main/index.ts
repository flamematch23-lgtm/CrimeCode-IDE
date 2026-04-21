import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Event } from "electron"
import { app, BrowserWindow, Notification, dialog } from "electron"
import pkg from "electron-updater"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
app.setPath("userData", join(app.getPath("appData"), app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"))
const { autoUpdater } = pkg

// Performance instrumentation
const perf = {
  marks: new Map<string, number>(),
  mark(label: string) {
    this.marks.set(label, performance.now())
  },
  measure(label: string, start: string, end?: string) {
    const s = this.marks.get(start)
    const e = end ? this.marks.get(end) : performance.now()
    if (s !== undefined && e !== undefined) {
      const duration = e - s
      logger.log(`perf: ${label}`, { duration: `${duration.toFixed(2)}ms` })
      return duration
    }
  },
}

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import type { CommandChild } from "./cli"
import { getSidecarPath, installCli, syncCli } from "./cli"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { licenseService, VALID_INTERVALS } from "./license"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { getDefaultServerUrl, getWslConfig, setDefaultServerUrl, setWslConfig, spawnLocalServer } from "./server"
import { createTray } from "./tray"
import { createLoadingWindow, createMainWindow, setBackgroundColor, setDockIcon } from "./windows"

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let sidecar: CommandChild | null = null
const loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
})

perf.mark("app_start")
setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    const forwardable = urls.filter((raw) => !handleActivateDeepLink(raw))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(forwardable)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    const urls = [url]
    const forwardable = urls.filter((raw) => !handleActivateDeepLink(raw))
    logger.log("deep link received via open-url", { url })
    emitDeepLinks(forwardable)
  })

  app.on("before-quit", () => {
    killSidecar()
  })

  app.on("will-quit", () => {
    killSidecar()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecar()
      app.exit(0)
    })
  }

  void app.whenReady().then(async () => {
    // migrate()
    perf.mark("app_ready")
    app.setAsDefaultProtocolClient("opencode")
    setDockIcon()
    perf.mark("pre_setup_complete")
    setupAutoUpdater()
    perf.mark("auto_updater_setup")
    // Kick an automatic update check shortly after launch and then every 30 minutes.
    if (UPDATER_ENABLED) {
      setTimeout(() => void checkForUpdates(false), 10_000)
      setInterval(() => void checkForUpdates(false), 30 * 60_000)
    }
    // Start CLI sync in background; don't wait for it
    void syncCli()
    perf.mark("cli_sync_started")
    await initialize()
  })
}

/**
 * Parses an `opencode://activate?...` deep-link URL, runs license activation if
 * the URL is well-formed, and returns whether the URL was consumed (so callers
 * can decide whether to forward it to the renderer as a regular deep link).
 */
function handleActivateDeepLink(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (err) {
    logger.warn("malformed deep link", { raw, err: String(err) })
    return false
  }
  if (!(parsed.host === "activate" || parsed.pathname.startsWith("/activate"))) {
    return false
  }
  const intervalRaw = parsed.searchParams.get("interval")
  const token = parsed.searchParams.get("token")
  if (!intervalRaw || !VALID_INTERVALS.has(intervalRaw) || !token) {
    logger.warn("activate deep link missing or invalid params", {
      hasInterval: !!intervalRaw,
      intervalValid: intervalRaw ? VALID_INTERVALS.has(intervalRaw) : false,
      hasToken: !!token,
    })
    return true // URL matched activate but was unusable — still consume it so it doesn't leak
  }
  logger.info("activating license from deep link", {
    interval: intervalRaw,
    tokenPrefix: token.slice(0, 8),
  })
  try {
    licenseService.activateFromToken({ interval: intervalRaw as "monthly" | "annual" | "lifetime", token })
    return true
  } catch (err) {
    logger.error("license activation failed", { err: String(err) })
    return true // activation attempted; don't double-process by forwarding
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize() {
  const needsMigration = !sqliteFileExists()
  const sqliteDone = needsMigration ? defer<void>() : undefined
  let overlay: BrowserWindow | null = null

  perf.mark("init_start")
  const port = await getSidecarPort()
  perf.mark("port_allocated")
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const binary = getSidecarPath()
  if (!existsSync(binary)) {
    logger.error("sidecar binary not found", { path: binary })
    dialog.showErrorBox(
      "OpenCode — Fatal Error",
      `The CLI sidecar binary was not found at:\n${binary}\n\nPlease reinstall the application.`,
    )
    app.exit(1)
    return
  }

  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    deepLinks: pendingDeepLinks,
  }

  logger.log("spawning sidecar", { url, binary })
  perf.mark("sidecar_spawn_start")
  const { child, health, events } = spawnLocalServer(hostname, port, password)
  perf.mark("sidecar_spawned")
  sidecar = child

  const stderrLines: string[] = []
  events.on("stderr", (line: string) => {
    stderrLines.push(line.trimEnd())
    logger.log("sidecar stderr", { line: line.trimEnd() })
  })

  events.on("error", (msg: string) => {
    logger.error("sidecar spawn error", { error: msg, binary })
    stderrLines.push(`[spawn error] ${msg}`)
  })

  events.on("sqlite", (progress: SqliteMigrationProgress) => {
    setInitStep({ phase: "sqlite_waiting" })
    if (overlay) sendSqliteMigrationProgress(overlay, progress)
    if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    if (progress.type === "Done") sqliteDone?.resolve()
  })

  overlay = createLoadingWindow(globals)
  perf.mark("loading_window_created")

  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    if (needsMigration) {
      await sqliteDone?.promise
    }

    await Promise.race([
      health.wait,
      delay(30_000).then(() => {
        throw new Error("Sidecar health check timed out after 30s")
      }),
    ])

    perf.mark("server_healthy")
    logger.log("loading task finished — server healthy")
  })()

  try {
    await loadingTask
  } catch (error: any) {
    overlay?.close()
    logger.error("sidecar failed to start", { error: error.message, stderr: stderrLines })
    const detail = stderrLines.length
      ? stderrLines.slice(-20).join("\n")
      : "No output captured from the sidecar process."
    const response = await dialog.showMessageBox({
      type: "error",
      title: "OpenCode — Server Error",
      message: "The local server could not be started.",
      detail: `${error.message}\n\nSidecar binary: ${binary}\nPort: ${port}\n\nLast output:\n${detail}`,
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response.response === 0) {
      logger.log("user chose retry — relaunching")
      killSidecar()
      app.relaunch()
      app.exit(0)
      return
    }
    logger.log("user chose quit")
    killSidecar()
    app.exit(1)
    return
  }

  serverReady.resolve({
    url,
    username: "opencode",
    password,
  })

  setInitStep({ phase: "done" })
  await loadingComplete.promise

  perf.mark("main_window_created_start")
  mainWindow = createMainWindow(globals)
  perf.mark("main_window_created")
  wireMenu()
  createTray({
    win: () => mainWindow,
    checkForUpdates: () => void checkForUpdates(true),
    newSession: () => mainWindow && sendMenuCommand(mainWindow, "session.new"),
    quit: () => {
      killSidecar()
      app.exit(0)
    },
  })

  overlay?.close()

  // Log startup summary
  perf.measure("app ready → port allocated", "app_ready", "port_allocated")
  perf.measure("sidecar spawn time", "sidecar_spawn_start", "sidecar_spawned")
  perf.measure("server health check", "sidecar_spawned", "server_healthy")
  perf.measure("loading window → main window", "loading_window_created", "main_window_created")
  perf.measure("total startup", "app_start", "main_window_created")
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    installCli: () => {
      void installCli()
    },
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      killSidecar()
      app.relaunch()
      app.exit(0)
    },
  })
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  installCli: async () => installCli(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  getUpdateState: () => getUpdateState(),
  setBackgroundColor: (color) => setBackgroundColor(color),
})

function killSidecar() {
  if (!sidecar) return
  const pid = sidecar.pid
  sidecar.kill()
  sidecar = null
  // tree-kill is async; also send process group signal as immediate fallback
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
  }
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("update-downloaded", (info) => {
    logger.log("update-downloaded event", { version: info.version })
    const notes = typeof info.releaseNotes === "string" ? info.releaseNotes : undefined
    updateState = { ready: true, version: info.version, notes, downloadedAt: Date.now() }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("update-ready", { version: info.version, notes })
    }
    try {
      const n = new Notification({
        title: "OpenCode Dev — Update Ready",
        body: `Version ${info.version} downloaded. Click to restart and install.`,
      })
      n.on("click", () => void installUpdate())
      n.show()
    } catch (err) {
      logger.error("notification failed", err)
    }
  })

  autoUpdater.on("error", (err) => {
    logger.error("autoUpdater error event", err)
    checkInProgress = false
  })

  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

type UpdateState = { ready: boolean; version?: string; notes?: string; downloadedAt?: number }
let updateState: UpdateState = { ready: false }
let checkInProgress = false
let checkStartedAt = 0

const CHECK_TIMEOUT = 60_000
const DOWNLOAD_TIMEOUT = 10 * 60_000
const STUCK_RECOVERY_MS = 5 * 60_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function getUpdateState(): UpdateState {
  return { ...updateState }
}

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }

  // Already downloaded — return cached state without re-checking.
  if (updateState.ready) {
    logger.log("checkUpdate short-circuit: update already ready", { version: updateState.version })
    return { updateAvailable: true, version: updateState.version, notes: updateState.notes }
  }

  // Recover from stuck check.
  if (checkInProgress && Date.now() - checkStartedAt > STUCK_RECOVERY_MS) {
    logger.warn("update check stuck, force-resetting", { stuckFor: Date.now() - checkStartedAt })
    checkInProgress = false
  }
  if (checkInProgress) {
    logger.log("checkUpdate skipped: already in progress")
    return { updateAvailable: false }
  }

  checkInProgress = true
  checkStartedAt = Date.now()
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
  })
  try {
    const result = await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT, "checkForUpdates")
    const info = result?.updateInfo
    const version = info?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available")
      return { updateAvailable: false }
    }
    logger.log("update available, downloading", { version })
    await withTimeout(autoUpdater.downloadUpdate(), DOWNLOAD_TIMEOUT, "downloadUpdate")
    logger.log("update download completed", { version })
    const notes = typeof info?.releaseNotes === "string" ? info.releaseNotes : undefined
    // update-downloaded event will also fire and update state, but set it here too for safety.
    updateState = { ready: true, version, notes, downloadedAt: Date.now() }
    return { updateAvailable: true, version, notes }
  } catch (err) {
    logger.error("update check failed", err)
    return { updateAvailable: false, failed: true }
  } finally {
    checkInProgress = false
  }
}

async function installUpdate() {
  if (!updateState.ready) {
    logger.warn("installUpdate called but no update ready")
    return
  }
  logger.log("installing update", { version: updateState.version })
  killSidecar()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
