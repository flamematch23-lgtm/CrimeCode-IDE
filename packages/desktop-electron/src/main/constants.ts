import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "opencode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
// Updater enabled when packaged. Set OPENCODE_NO_UPDATER=1 to disable.
export const UPDATER_ENABLED = app.isPackaged && process.env.OPENCODE_NO_UPDATER !== "1"
