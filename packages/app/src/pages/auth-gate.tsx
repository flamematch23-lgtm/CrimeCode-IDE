import { createSignal, Show, onMount } from "solid-js"
import type { JSX } from "solid-js"

/**
 * AuthGate — wraps the AppInterface with a simple login form that collects
 * (server URL, username, password), stores them in localStorage, and only
 * renders the protected tree once we've verified the credentials work.
 *
 * Security notes:
 * - localStorage is scoped per-origin; other sites can't read it.
 * - Credentials are sent as HTTP Basic Auth over HTTPS (transport-encrypted).
 * - No credentials are bundled into the JS; only the DEFAULT URL is.
 * - Logout wipes all three keys and reloads the page.
 */

const STORAGE_KEYS = {
  url: "opencode.auth.serverUrl",
  username: "opencode.auth.username",
  password: "opencode.auth.password",
} as const

const DEFAULT_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? ""
const DEFAULT_USERNAME = "opencode"

export type Credentials = {
  url: string
  username: string
  password: string
}

export function readCredentials(): Credentials | null {
  if (typeof localStorage === "undefined") return null
  const url = localStorage.getItem(STORAGE_KEYS.url)
  const username = localStorage.getItem(STORAGE_KEYS.username)
  const password = localStorage.getItem(STORAGE_KEYS.password)
  if (!url) return null
  return { url, username: username ?? "", password: password ?? "" }
}

export function writeCredentials(creds: Credentials): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEYS.url, creds.url)
  localStorage.setItem(STORAGE_KEYS.username, creds.username)
  localStorage.setItem(STORAGE_KEYS.password, creds.password)
}

export function clearCredentials(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(STORAGE_KEYS.url)
  localStorage.removeItem(STORAGE_KEYS.username)
  localStorage.removeItem(STORAGE_KEYS.password)
}

async function verifyCredentials(creds: Credentials): Promise<{ ok: boolean; message?: string }> {
  try {
    const auth = "Basic " + btoa(`${creds.username}:${creds.password}`)
    const url = creds.url.replace(/\/+$/, "") + "/global/config"
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: auth },
      mode: "cors",
      credentials: "omit",
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, message: "Invalid username or password." }
    return { ok: false, message: `Server returned HTTP ${response.status}.` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Network error: ${msg}` }
  }
}

export function AuthGate(props: { children: (creds: Credentials) => JSX.Element }) {
  const [creds, setCreds] = createSignal<Credentials | null>(null)
  const [checking, setChecking] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [url, setUrl] = createSignal(DEFAULT_URL)
  const [username, setUsername] = createSignal(DEFAULT_USERNAME)
  const [password, setPassword] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  onMount(async () => {
    const stored = readCredentials()
    if (!stored) {
      setChecking(false)
      return
    }
    const result = await verifyCredentials(stored)
    if (result.ok) {
      setCreds(stored)
    } else {
      setError(result.message ?? "Stored credentials are no longer valid.")
      setUrl(stored.url)
      setUsername(stored.username)
    }
    setChecking(false)
  })

  async function handleSubmit(e: Event) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const next: Credentials = {
      url: url().replace(/\/+$/, ""),
      username: username(),
      password: password(),
    }
    const result = await verifyCredentials(next)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.message ?? "Unable to verify credentials.")
      return
    }
    writeCredentials(next)
    setCreds(next)
  }

  return (
    <Show
      when={creds()}
      fallback={
        <Show
          when={!checking()}
          fallback={
            <div data-auth-gate="loading" style={loadingStyle}>
              <p>Checking saved credentials…</p>
            </div>
          }
        >
          <form data-auth-gate="form" onSubmit={handleSubmit} style={formStyle}>
            <div style={cardStyle}>
              <h1 style={titleStyle}>Sign in to OpenCode</h1>
              <p style={subtitleStyle}>Connect to your self-hosted OpenCode server.</p>

              <label style={labelStyle}>
                <span>Server URL</span>
                <input
                  type="url"
                  required
                  value={url()}
                  onInput={(e) => setUrl(e.currentTarget.value)}
                  placeholder="https://crimecode-api.fly.dev"
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                <span>Username</span>
                <input
                  type="text"
                  required
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                  autocomplete="username"
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                <span>Password</span>
                <input
                  type="password"
                  required
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  autocomplete="current-password"
                  style={inputStyle}
                />
              </label>

              <Show when={error()}>
                {(msg) => (
                  <p data-slot="error" style={errorStyle}>
                    {msg()}
                  </p>
                )}
              </Show>

              <button type="submit" disabled={submitting()} style={buttonStyle}>
                {submitting() ? "Signing in…" : "Sign in"}
              </button>

              <p style={hintStyle}>
                Credentials are stored in your browser&apos;s localStorage and sent as HTTP Basic Auth over HTTPS.
              </p>
            </div>
          </form>
        </Show>
      }
    >
      {(c) => props.children(c())}
    </Show>
  )
}

export function logout(): void {
  clearCredentials()
  window.location.reload()
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline styles — keep the login screen standalone so it renders before the
// theme system is initialized.
// ─────────────────────────────────────────────────────────────────────────────

const loadingStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "min-height": "100vh",
  "font-family": "system-ui, -apple-system, sans-serif",
  color: "#ccc",
  background: "#111",
}

const formStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "min-height": "100vh",
  padding: "24px",
  background: "#111",
  "font-family": "system-ui, -apple-system, sans-serif",
}

const cardStyle: JSX.CSSProperties = {
  width: "100%",
  "max-width": "380px",
  padding: "32px",
  background: "#1a1a1a",
  border: "1px solid #333",
  "border-radius": "12px",
  "box-shadow": "0 8px 32px rgba(0,0,0,0.4)",
}

const titleStyle: JSX.CSSProperties = {
  margin: "0 0 8px 0",
  "font-size": "22px",
  "font-weight": "600",
  color: "#fff",
}

const subtitleStyle: JSX.CSSProperties = {
  margin: "0 0 24px 0",
  "font-size": "14px",
  color: "#999",
}

const labelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
  "margin-bottom": "16px",
  "font-size": "13px",
  color: "#ccc",
}

const inputStyle: JSX.CSSProperties = {
  padding: "10px 12px",
  background: "#0a0a0a",
  border: "1px solid #333",
  "border-radius": "6px",
  color: "#fff",
  "font-size": "14px",
  "font-family": "inherit",
  outline: "none",
}

const buttonStyle: JSX.CSSProperties = {
  width: "100%",
  padding: "12px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  "border-radius": "6px",
  "font-size": "14px",
  "font-weight": "500",
  cursor: "pointer",
}

const errorStyle: JSX.CSSProperties = {
  margin: "0 0 12px 0",
  padding: "10px 12px",
  background: "#451717",
  border: "1px solid #7f1d1d",
  "border-radius": "6px",
  color: "#fca5a5",
  "font-size": "13px",
}

const hintStyle: JSX.CSSProperties = {
  margin: "16px 0 0 0",
  "font-size": "11px",
  color: "#666",
  "line-height": "1.4",
}
