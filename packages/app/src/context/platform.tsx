import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateInfo = { updateAvailable: boolean; version?: string; notes?: string }

/** Information about a Chrome instance discovered locally. Mirrors the
 *  ConnectedBrowser shape exposed by the Electron preload. */
export type ConnectedBrowserInfo = {
  id: string
  label: string
  url: string
  port: number
}

/** Status of the computer-use master toggle. The reason field explains why
 *  activation was refused (or why the feature is unavailable). */
export type ComputerUseStatus = {
  enabled: boolean
  reason?: "not-activated" | "platform-unsupported" | "permission-denied"
}

/** Status of the apps-restore feature. */
export type AppsRestoreStatus = { enabled: boolean; pending: number }

/** Optional platform-level Automation API. Only the desktop platform
 *  implements this; on web the renderer hides the whole settings tab. */
export type AutomationAPI = {
  getBrowserAllowAll(): Promise<boolean>
  setBrowserAllowAll(value: boolean): Promise<void>
  listConnectedBrowsers(): Promise<ConnectedBrowserInfo[]>
  getComputerUseStatus(): Promise<ComputerUseStatus>
  setComputerUseEnabled(value: boolean): Promise<ComputerUseStatus>
  getRestoreApps(): Promise<AppsRestoreStatus>
  setRestoreApps(value: boolean): Promise<AppsRestoreStatus>
}

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Git commit hash */
  commit?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for updates (Tauri only) */
  checkUpdate?(): Promise<UpdateInfo>

  /** Install updates (Tauri only) */
  update?(): Promise<void>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Subscribe to update download progress (desktop only, returns cleanup fn) */
  onUpdateProgress?(cb: (percent: number) => void): () => void

  /** Start forwarding update progress events (desktop only) */
  subscribeUpdateProgress?(): Promise<void>

  /** Subscribe to update-ready event (desktop only, returns cleanup fn) */
  onUpdateReady?(cb: (info: { version: string; notes?: string }) => void): () => void

  /** Automation panel API (desktop only). Renderer hides the tab when this
   *  is undefined, e.g. on the web platform. */
  automation?: AutomationAPI
}

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
