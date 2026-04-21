import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "opencode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
// Updater enabled when packaged. Set OPENCODE_NO_UPDATER=1 to disable.
export const UPDATER_ENABLED = app.isPackaged && process.env.OPENCODE_NO_UPDATER !== "1"

export const LICENSE_STORE = "opencode.license"
export const LICENSE_KEY = "record"

/**
 * Base URL for Stripe Checkout redirector. The URL is expected to redirect back
 * to `opencode://activate?token=…` after successful payment.
 */
export const CHECKOUT_BASE_URL =
  import.meta.env.OPENCODE_CHECKOUT_BASE_URL ?? "https://opencode.ai/billing/pro"

/**
 * SHA-256 hex digest of the build-time admin passphrase. Never stored in
 * plaintext. Set via the OPENCODE_ADMIN_PASSPHRASE_SHA256 env var at build time.
 * When empty, admin panel is only reachable in dev builds.
 */
export const ADMIN_PASSPHRASE_SHA256 = (import.meta.env.OPENCODE_ADMIN_PASSPHRASE_SHA256 ?? "").toLowerCase()
