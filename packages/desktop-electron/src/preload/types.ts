export type InitStep = { phase: "server_waiting" } | { phase: "sqlite_waiting" } | { phase: "done" }

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

export type WslConfig = { enabled: boolean }

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}

export type ContextMenuItem = {
  id: string
  label: string
  type?: "separator" | "normal"
  enabled?: boolean
}

export type ProInterval = "monthly" | "annual" | "lifetime"
export type LicenseStatus = "free" | "trial" | "trial_expired" | "active" | "expired" | "revoked"

/**
 * IPC wire shape for the license state. Date fields are ISO 8601 strings (not
 * `Date` objects) because they cross the process boundary already serialized by
 * the main-side `toSnapshot()` helper. Use `new Date(iso)` in the renderer to
 * rehydrate when needed.
 *
 * NOTE: distinct from `ProjectedLicense` in `src/main/license/state.ts`, which
 * is the in-process shape with real `Date` fields.
 */
export interface LicenseSnapshot {
  status: LicenseStatus
  interval: ProInterval | null
  timeTrialEnd: string | null
  timeTrialConsumed: string | null
  timeIssued: string | null
  timeExpiry: string | null
  licenseToken: string | null
  issuedBy: "stripe" | "admin" | null
  effectiveStatus: LicenseStatus
  trialDaysRemaining: number | null
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  toggleProxy: (enabled: boolean, target?: string, auth?: string) => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string; notes?: string }>
  installUpdate: () => Promise<void>
  getUpdateState: () => Promise<{ ready: boolean; version?: string; notes?: string; downloadedAt?: number }>
  onUpdateReady: (cb: (info: { version: string; notes?: string }) => void) => () => void
  setBackgroundColor: (color: string) => Promise<void>

  license: {
    readonly get: () => Promise<LicenseSnapshot>
    readonly startTrial: () => Promise<LicenseSnapshot>
    readonly openCheckout: (payload: { interval: ProInterval; contact: "opcrime" | "jollyfraud" }) => Promise<void>
    readonly activateToken: (payload: { interval: ProInterval; token: string }) => Promise<LicenseSnapshot>
  }
  admin: {
    readonly status: () => Promise<{ unlocked: boolean }>
    readonly unlock: (passphrase: string) => Promise<{ unlocked: boolean }>
    readonly lock: () => Promise<{ unlocked: boolean }>
    readonly grant: (interval: ProInterval) => Promise<LicenseSnapshot>
    readonly revoke: () => Promise<LicenseSnapshot>
    readonly extendTrial: (days: number) => Promise<LicenseSnapshot>
    readonly reset: () => Promise<LicenseSnapshot>
  }
  account: {
    readonly get: () => Promise<{
      token: string
      customer_id: string
      telegram_user_id: number | null
      expires_at: number
      signed_in_at: number
    } | null>
    readonly startSignIn: () => Promise<{ pin: string; expires_at: number; bot_url: string }>
    readonly pollSignIn: (pin: string) => Promise<{
      token: string
      customer_id: string
      telegram_user_id: number | null
      expires_at: number
      signed_in_at: number
    } | null>
    readonly logout: () => Promise<void>
    readonly syncGet: (key: string) => Promise<{ key: string; value: string; updated_at: number } | null>
    readonly syncPut: (key: string, value: string) => Promise<{ key: string; value: string; updated_at: number }>
  }
  project: {
    readonly create: () => Promise<{ directory: string } | null>
  }
  teams: {
    readonly list: () => Promise<{ teams: Array<TeamSummary> }>
    readonly create: (name: string) => Promise<{ team: TeamSummary }>
    readonly detail: (id: string) => Promise<TeamDetailPayload>
    readonly rename: (id: string, name: string) => Promise<{ team: TeamSummary }>
    readonly delete: (id: string) => Promise<{ ok: true }>
    readonly addMember: (id: string, identifier: string) => Promise<AddMemberPayload>
    readonly removeMember: (id: string, customerId: string) => Promise<{ ok: true }>
    readonly setMemberRole: (id: string, customerId: string, role: string) => Promise<{ member: TeamMember }>
    readonly cancelInvite: (id: string, inviteId: string) => Promise<{ ok: true }>
    readonly listSessions: (id: string) => Promise<{ sessions: TeamLiveSession[] }>
    readonly publishSession: (id: string, title: string, state: unknown) => Promise<TeamLiveSession>
    readonly heartbeatSession: (id: string, sid: string, state: unknown) => Promise<TeamLiveSession | null>
    readonly endSession: (id: string, sid: string) => Promise<{ ok: true }>
  }

  // Enhancement 3: Native context menus
  showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>

  // Enhancement 5: Session export — write file to disk
  writeFile: (path: string, content: string) => Promise<void>

  // Enhancement 8: Update progress
  onUpdateProgress: (cb: (percent: number) => void) => () => void
  subscribeUpdateProgress: () => Promise<void>

  // Browser tool - integrated with AI Agent
  browserNavigate: (
    url: string,
    timeout?: number,
  ) => Promise<{
    success: boolean
    title?: string
    url?: string
    screenshot?: string
    error?: string
  }>
  browserScreenshot: () => Promise<{ success: boolean; screenshot?: string; error?: string }>
  browserContent: () => Promise<{ success: boolean; title?: string; content?: string; error?: string }>
  browserClose: () => Promise<{ success: boolean }>
  onBrowserScreenshot: (cb: (screenshot: string | null) => void) => () => void
  browserPreviewNavigate: (url: string) => Promise<void>
  onBrowserPreviewNavigate: (cb: (url: string) => void) => () => void

  // Window management
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  windowSnap: (position: "left" | "right" | "top" | "bottom" | "center") => Promise<void>
  windowSetAlwaysOnTop: (flag: boolean) => Promise<void>
  windowIsAlwaysOnTop: () => Promise<boolean>
  windowStateGet: (key: string) => Promise<any>
  windowStateSet: (key: string, value: any) => Promise<void>

  // Screen sharing
  getScreenSources: (opts?: {
    types?: Array<"screen" | "window">
    thumbnail?: { width: number; height: number }
  }) => Promise<
    Array<{ id: string; name: string; type: "screen" | "window"; thumbnail: string; appIcon: string | null }>
  >
}

export type TeamRole = "owner" | "admin" | "member"

export interface TeamSummary {
  id: string
  name: string
  owner_customer_id: string
  created_at: number
  role?: TeamRole
  member_count?: number
}

export interface TeamMember {
  team_id: string
  customer_id: string
  role: TeamRole
  added_at: number
  display: string | null
  telegram_user_id: number | null
  telegram: string | null
}

export interface TeamInvite {
  id: string
  team_id: string
  identifier: string
  role: TeamRole
  invited_by: string
  created_at: number
}

export interface TeamDetailPayload {
  team: TeamSummary
  members: TeamMember[]
  invites: TeamInvite[]
  self_role: TeamRole
}

export interface AddMemberPayload {
  mode: "added" | "invited"
  member?: TeamMember
  invite?: TeamInvite
}

export interface TeamLiveSession {
  id: string
  team_id: string
  host_customer_id: string
  title: string
  state: string | null
  created_at: number
  last_heartbeat_at: number
  ended_at: number | null
}
