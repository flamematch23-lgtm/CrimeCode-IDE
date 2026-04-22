// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"
import { AuthGate, readCredentials } from "./pages/auth-gate"

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
 * Web-only fetch wrapper that auto-attaches HTTP Basic Auth from credentials
 * saved by AuthGate. Used by raw `platform.fetch(...)` call sites (security.tsx,
 * highlights.tsx, server-health.ts) that bypass the SDK client auth.
 */
const authFetch = ((input, init) => {
  const creds = readCredentials()
  if (!creds?.username || !creds?.password) {
    return fetch(input, init)
  }
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has("Authorization")) {
    headers.set("Authorization", "Basic " + btoa(`${creds.username}:${creds.password}`))
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

if (root instanceof HTMLElement) {
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
              </AppBaseProviders>
            </PlatformProvider>
          )
        }}
      </AuthGate>
    ),
    root,
  )
}
