import { contextBridge, ipcRenderer } from "electron"
import type { ContextMenuItem, ElectronAPI, InitStep, SqliteMigrationProgress } from "./types"

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  toggleProxy: (enabled, target, auth, proxyUrl) => ipcRenderer.invoke("toggle-proxy", enabled, target, auth, proxyUrl),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on("init-step", handler)
    return ipcRenderer.invoke("await-initialization").finally(() => {
      ipcRenderer.removeListener("init-step", handler)
    })
  },
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getWslConfig: () => ipcRenderer.invoke("get-wsl-config"),
  setWslConfig: (config) => ipcRenderer.invoke("set-wsl-config", config),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  wslPath: (path, mode) => ipcRenderer.invoke("wsl-path", path, mode),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onSqliteMigrationProgress: (cb) => {
    const handler = (_: unknown, progress: SqliteMigrationProgress) => cb(progress)
    ipcRenderer.on("sqlite-migration-progress", handler)
    return () => ipcRenderer.removeListener("sqlite-migration-progress", handler)
  },
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  loadingWindowComplete: () => ipcRenderer.invoke("loading-window-complete"),
  runUpdater: (alertOnFail) => ipcRenderer.invoke("run-updater", alertOnFail),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  onUpdateReady: (cb) => {
    const handler = (_: unknown, info: { version: string; notes?: string }) => cb(info)
    ipcRenderer.on("update-ready", handler)
    return () => ipcRenderer.removeListener("update-ready", handler)
  },
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),

  license: {
    get: () => ipcRenderer.invoke("license-get"),
    startTrial: () => ipcRenderer.invoke("license-start-trial"),
    openCheckout: (payload) => ipcRenderer.invoke("license-open-checkout", payload),
    activateToken: (payload) => ipcRenderer.invoke("license-activate-token", payload),
  },
  admin: {
    status: () => ipcRenderer.invoke("admin-status"),
    unlock: (passphrase) => ipcRenderer.invoke("admin-unlock", passphrase),
    lock: () => ipcRenderer.invoke("admin-lock"),
    grant: (interval) => ipcRenderer.invoke("admin-grant", interval),
    revoke: () => ipcRenderer.invoke("admin-revoke"),
    extendTrial: (days) => ipcRenderer.invoke("admin-extend-trial", days),
    reset: () => ipcRenderer.invoke("admin-reset"),
  },
  account: {
    get: () => ipcRenderer.invoke("account-get"),
    startSignIn: () => ipcRenderer.invoke("account-start-signin"),
    pollSignIn: (pin: string) => ipcRenderer.invoke("account-poll-signin", pin),
    logout: () => ipcRenderer.invoke("account-logout"),
    syncGet: (key: string) => ipcRenderer.invoke("account-sync-get", key),
    syncPut: (key: string, value: string) => ipcRenderer.invoke("account-sync-put", key, value),
    syncList: () => ipcRenderer.invoke("account-sync-list"),
  },
  project: {
    create: () => ipcRenderer.invoke("project-create"),
  },
  teams: {
    list: () => ipcRenderer.invoke("teams-list"),
    create: (name: string) => ipcRenderer.invoke("teams-create", name),
    detail: (id: string) => ipcRenderer.invoke("teams-detail", id),
    rename: (id: string, name: string) => ipcRenderer.invoke("teams-rename", id, name),
    delete: (id: string) => ipcRenderer.invoke("teams-delete", id),
    addMember: (id: string, identifier: string) => ipcRenderer.invoke("teams-add-member", id, identifier),
    removeMember: (id: string, customerId: string) => ipcRenderer.invoke("teams-remove-member", id, customerId),
    setMemberRole: (id: string, customerId: string, role: string) =>
      ipcRenderer.invoke("teams-set-member-role", id, customerId, role),
    cancelInvite: (id: string, inviteId: string) => ipcRenderer.invoke("teams-cancel-invite", id, inviteId),
    listSessions: (id: string) => ipcRenderer.invoke("teams-list-sessions", id),
    publishSession: (id: string, title: string, state: unknown) =>
      ipcRenderer.invoke("teams-publish-session", id, title, state),
    heartbeatSession: (id: string, sid: string, state: unknown) =>
      ipcRenderer.invoke("teams-heartbeat-session", id, sid, state),
    endSession: (id: string, sid: string) => ipcRenderer.invoke("teams-end-session", id, sid),
  },

  // Enhancement 3: Native context menus
  showContextMenu: (items: ContextMenuItem[]) => ipcRenderer.invoke("show-context-menu", items),

  // Enhancement 5: Write file (session export)
  writeFile: (path: string, content: string) => ipcRenderer.invoke("write-file", path, content),

  // Enhancement 8: Update progress
  onUpdateProgress: (cb: (percent: number) => void) => {
    const handler = (_: unknown, percent: number) => cb(percent)
    ipcRenderer.on("update-progress", handler)
    return () => ipcRenderer.removeListener("update-progress", handler)
  },
  subscribeUpdateProgress: () => ipcRenderer.invoke("subscribe-update-progress"),

  // Browser tool - integrated with AI Agent
  browserNavigate: (url: string, timeout?: number) => ipcRenderer.invoke("browser-navigate", url, timeout),
  browserScreenshot: () => ipcRenderer.invoke("browser-screenshot"),
  browserContent: () => ipcRenderer.invoke("browser-content"),
  browserClose: () => ipcRenderer.invoke("browser-close"),
  onBrowserScreenshot: (cb: (screenshot: string | null) => void) => {
    const handler = (_: unknown, screenshot: string | null) => cb(screenshot)
    ipcRenderer.on("browser-screenshot-update", handler)
    return () => ipcRenderer.removeListener("browser-screenshot-update", handler)
  },
  browserPreviewNavigate: (url: string) => ipcRenderer.invoke("browser-preview-navigate", url),
  onBrowserPreviewNavigate: (cb: (url: string) => void) => {
    const handler = (_: unknown, url: string) => cb(url)
    ipcRenderer.on("browser-preview-navigate", handler)
    return () => ipcRenderer.removeListener("browser-preview-navigate", handler)
  },

  // Window management
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  windowSnap: (position: "left" | "right" | "top" | "bottom" | "center") => ipcRenderer.invoke("window-snap", position),
  windowSetAlwaysOnTop: (flag: boolean) => ipcRenderer.invoke("window-set-always-on-top", flag),
  windowIsAlwaysOnTop: () => ipcRenderer.invoke("window-is-always-on-top"),
  windowStateGet: (key: string) => ipcRenderer.invoke("window-state-get", key),
  windowStateSet: (key: string, value: any) => ipcRenderer.invoke("window-state-set", key, value),

  getScreenSources: (opts) => ipcRenderer.invoke("get-screen-sources", opts),
}

contextBridge.exposeInMainWorld("api", api)
