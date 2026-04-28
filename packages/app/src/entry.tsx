// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"
import { AuthGate, buildAuthHeader, readCredentials } from "./pages/auth-gate"
import { LiveCursors } from "./components/teams/live-cursors"
import { hydrateTeamSessionFromStorage } from "./utils/team-session"
import { Router, Route } from "@solidjs/router"
import { lazy as solidLazy } from "solid-js"

const ReferralLandingRoute = solidLazy(() => import("@/pages/referral-landing"))

// Re-attach to whatever team-session id was in localStorage before the
// reload, restarting the heartbeat loop so we don't get reaped. Cheap and
// idempotent — safe to run unconditionally on every entry boot.
//
// Wrapped in try/catch + an env-guard because this runs at module top
// level: any synchronous throw here (storage access denied, broken
// localStorage shim during SSR, getTeamsClient() init quirk, …) would
// abort the entire entry script and the user would see a blank screen
// instead of the IDE.
try {
  if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
    hydrateTeamSessionFromStorage()
  }
} catch (err) {
  console.warn("[entry] hydrateTeamSessionFromStorage failed; continuing", err)
}

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: new URL("/favicon-96x96-v3.png", window.location.origin).href,
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  // Explicit build-time override takes precedence (e.g. Cloudflare Pages deploy pointing to Fly.io API).
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

/**
 * Web-only fetch wrapper that auto-attaches the right Authorization header
 * (Bearer for Telegram sessions, Basic for legacy self-hosted servers) based
 * on the credentials saved by AuthGate. Used by raw `platform.fetch(...)`
 * call sites (security.tsx, highlights.tsx, server-health.ts) that bypass
 * the SDK client auth.
 */
const authFetch = ((input, init) => {
  const creds = readCredentials()
  if (!creds?.password) {
    return fetch(input, init)
  }
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has("Authorization")) {
    headers.set("Authorization", buildAuthHeader(creds))
  }
  return fetch(input, { ...init, headers })
}) as Platform["fetch"]

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  fetch: authFetch,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

// Pre-auth landing pages: /r/<CODE> for the referral share-link.
// We render this OUTSIDE the AuthGate so unauthenticated visitors clicking
// a friend's link see the welcome card immediately — without first being
// kicked through the sign-in flow. The landing page stashes the code in
// localStorage and then navigates to "/", at which point the AuthGate
// takes over and the signup form auto-fills the bonus code.
const isReferralPath = typeof window !== "undefined" && /^\/r\/[A-Za-z0-9]{4,32}\/?$/.test(window.location.pathname)

if (root instanceof HTMLElement) {
  if (isReferralPath) {
    render(
      () => (
        <Router>
          <Route path="/r/:code" component={ReferralLandingRoute} />
        </Router>
      ),
      root,
    )
  } else {
    render(
      () => (
        <AuthGate>
          {(creds) => {
            const server: ServerConnection.Http = {
              type: "http",
              http: { url: creds.url, username: creds.username, password: creds.password },
            }
            return (
              <PlatformProvider value={platform}>
                <AppBaseProviders>
                  <AppInterface
                    defaultServer={ServerConnection.Key.make(creds.url)}
                    servers={[server]}
                    disableHealthCheck
                  />
                  <LiveCursors />
                  {/* WorkspaceSwitcher is now mounted directly inside the
                      titlebar (see components/titlebar.tsx) so it lives in
                      the chrome instead of a position:fixed overlay that
                      used to collide with the session-header buttons.
                      Self-hosted users still get the switcher — it'll just
                      show "Sign in to create or join teams" in the popover. */}
                </AppBaseProviders>
              </PlatformProvider>
            )
          }}
        </AuthGate>
      ),
      root,
    )
  }
}
