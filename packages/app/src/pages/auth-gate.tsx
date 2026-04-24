import { createSignal, Show, Switch, Match, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import {
  readWebSession,
  signInWithAccount,
  signUpWithAccount,
  writeWebSession,
} from "../utils/teams-client"

/**
 * AuthGate — wraps the AppInterface. Two sign-in paths:
 *   1. Telegram magic-link (primary): /license/auth/start → user taps the
 *      bot link → client polls → JWT session is written to localStorage.
 *   2. Self-hosted Basic Auth (advanced): keeps the legacy (url,user,pass)
 *      combo for people running their own opencode server.
 *
 * The rest of the app reads credentials via readCredentials() and always
 * gets a {url, username, password} shape — for Bearer sessions `username`
 * is "bearer" and `password` is the JWT, so the app's `fetch` wrapper that
 * builds `Authorization: Basic ${btoa(user:pass)}` has been replaced by
 * a branching helper (`buildAuthHeader`) that emits the right header.
 */

const STORAGE_KEYS = {
  url: "opencode.auth.serverUrl",
  username: "opencode.auth.username",
  password: "opencode.auth.password",
} as const

const DEFAULT_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "https://api.crimecode.cc"

export type Credentials = {
  url: string
  username: string
  password: string
  /** "basic" for legacy self-hosted auth, "bearer" for Telegram JWT. */
  kind?: "basic" | "bearer"
}

export function readCredentials(): Credentials | null {
  if (typeof localStorage === "undefined") return null
  const session = readWebSession()
  if (session) {
    return { url: DEFAULT_URL, username: "bearer", password: session.token, kind: "bearer" }
  }
  const url = localStorage.getItem(STORAGE_KEYS.url)
  const username = localStorage.getItem(STORAGE_KEYS.username)
  const password = localStorage.getItem(STORAGE_KEYS.password)
  if (!url) return null
  return { url, username: username ?? "", password: password ?? "", kind: "basic" }
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
  writeWebSession(null)
}

export function buildAuthHeader(creds: Credentials): string {
  if (creds.kind === "bearer") return `Bearer ${creds.password}`
  return "Basic " + btoa(`${creds.username}:${creds.password}`)
}

async function verifyCredentials(creds: Credentials): Promise<{ ok: boolean; message?: string }> {
  try {
    const url = creds.url.replace(/\/+$/, "") + "/global/config"
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: buildAuthHeader(creds) },
      mode: "cors",
      credentials: "omit",
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, message: "Not authorized. Please sign in again." }
    return { ok: false, message: `Server returned HTTP ${response.status}.` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Network error: ${msg}` }
  }
}

interface PinState {
  pin: string
  bot_url: string
  expires_at: number
}

async function startTgAuth(): Promise<PinState> {
  const res = await fetch(`${DEFAULT_URL}/license/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_label: navigator.userAgent.slice(0, 80) }),
  })
  if (!res.ok) throw new Error(`auth/start ${res.status}`)
  return (await res.json()) as PinState
}

async function pollTgAuth(pin: string): Promise<
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ok"; token: string; exp: number; customer_id: string }
  | { status: "unknown" }
> {
  const res = await fetch(`${DEFAULT_URL}/license/auth/poll/${encodeURIComponent(pin)}`)
  if (!res.ok) throw new Error(`auth/poll ${res.status}`)
  return (await res.json()) as never
}

export function AuthGate(props: { children: (creds: Credentials) => JSX.Element }) {
  const [creds, setCreds] = createSignal<Credentials | null>(null)
  const [checking, setChecking] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [mode, setMode] = createSignal<"telegram" | "account">("telegram")
  const [accountMode, setAccountMode] = createSignal<"signin" | "signup">("signin")

  // Telegram flow state
  const [pinState, setPinState] = createSignal<PinState | null>(null)
  const [polling, setPolling] = createSignal(false)

  // Account form state
  const [accUsername, setAccUsername] = createSignal("")
  const [accPassword, setAccPassword] = createSignal("")
  const [accTelegram, setAccTelegram] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    setPolling(false)
  }
  onCleanup(stopPoll)

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
      // If it was a Bearer session that expired, kick the user to the
      // Account tab where they can sign in again with their username.
      if (stored.kind === "bearer") setMode("account")
      // Clear the stored session so we don't re-use it next reload.
      clearCredentials()
    }
    setChecking(false)
  })

  async function startTelegram() {
    stopPoll()
    setError(null)
    try {
      const s = await startTgAuth()
      setPinState(s)
      setPolling(true)
      window.open(s.bot_url, "_blank", "noopener")
      pollTimer = setInterval(async () => {
        try {
          const r = await pollTgAuth(s.pin)
          if (r.status === "ok") {
            stopPoll()
            writeWebSession({
              token: r.token,
              customer_id: r.customer_id,
              telegram_user_id: null,
              expires_at: r.exp,
            })
            const next: Credentials = { url: DEFAULT_URL, username: "bearer", password: r.token, kind: "bearer" }
            writeCredentials(next)
            setCreds(next)
            setPinState(null)
          }
          if (r.status === "expired" || r.status === "unknown") {
            stopPoll()
            setPinState(null)
            setError("PIN expired. Please start again.")
          }
        } catch (err) {
          stopPoll()
          setPinState(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function friendlyAuthError(code: string): string {
    const map: Record<string, string> = {
      invalid_username: "Username must be 3–32 chars (letters, digits, underscore, dash, dot).",
      invalid_password: "Password must be at least 8 characters.",
      username_taken: "That username is already in use. Try signing in instead.",
      invalid_credentials: "Wrong username or password.",
      account_revoked: "This account has been disabled. Contact @OpCrime1312.",
      missing_credentials: "Enter both a username and a password.",
      rate_limited: "Too many attempts. Try again in a minute.",
    }
    return map[code] ?? code
  }

  async function submitAccount(e: Event) {
    e.preventDefault()
    setError(null)
    // Re-validate client-side before hitting the server. The HTML5 minlength
    // attribute is bypassable when JS submits the form, and we'd rather show
    // an inline error than burn a rate-limit slot on the backend.
    const trimmedUser = accUsername().trim()
    if (trimmedUser.length < 3 || trimmedUser.length > 32 || !/^[a-zA-Z0-9_.\-]+$/.test(trimmedUser)) {
      setError(friendlyAuthError("invalid_username"))
      return
    }
    if (accPassword().length < 8) {
      setError(friendlyAuthError("invalid_password"))
      return
    }
    setSubmitting(true)
    try {
      const fn = accountMode() === "signup" ? signUpWithAccount : signInWithAccount
      const session = await fn({
        username: trimmedUser,
        password: accPassword(),
        ...(accountMode() === "signup" && accTelegram().trim()
          ? { telegram: accTelegram().trim() }
          : {}),
        device_label: `web (${navigator.userAgent.slice(0, 60)})`,
      })
      writeWebSession({
        token: session.token,
        customer_id: session.customer_id,
        telegram_user_id: null,
        expires_at: session.exp,
      })
      const next: Credentials = {
        url: DEFAULT_URL,
        username: "bearer",
        password: session.token,
        kind: "bearer",
      }
      writeCredentials(next)
      setCreds(next)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(friendlyAuthError(msg))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Show
      when={creds()}
      fallback={
        <Show
          when={!checking()}
          fallback={
            <div data-auth-gate="loading" style={loadingStyle} role="status" aria-live="polite">
              <p>Checking saved credentials…</p>
            </div>
          }
        >
          <div data-auth-gate="form" style={formStyle}>
            <div style={cardStyle}>
              <a href="/home" style={newHereStyle}>
                🆕 New to CrimeCode? <span style={{ "text-decoration": "underline" }}>Learn what it is →</span>
              </a>
              <h1 style={titleStyle}>Sign in to CrimeCode</h1>
              <p style={subtitleStyle}>Pick a sign-in method below.</p>

              <div style={tabsStyle}>
                <button
                  type="button"
                  data-active={mode() === "telegram"}
                  onClick={() => setMode("telegram")}
                  style={tabStyle(mode() === "telegram")}
                >
                  📱 Telegram
                </button>
                <button
                  type="button"
                  data-active={mode() === "account"}
                  onClick={() => setMode("account")}
                  style={tabStyle(mode() === "account")}
                >
                  👤 Account
                </button>
              </div>

              <Switch>
                <Match when={mode() === "telegram"}>
                  <Show
                    when={pinState() && polling()}
                    fallback={
                      <div>
                        <p style={descriptionStyle}>
                          Sign in with your Telegram account via <b>@CrimeCodeSub_bot</b>. No email, no password —
                          you'll get a one-time PIN to link this browser.
                        </p>
                        <button type="button" onClick={startTelegram} style={primaryButtonStyle}>
                          Continue with Telegram
                        </button>
                      </div>
                    }
                  >
                    {(_) => {
                      const s = pinState()!
                      return (
                        <div>
                          <p style={descriptionStyle}>Open Telegram and enter this one-time PIN:</p>
                          <div style={pinStyle}>{s.pin}</div>
                          <p style={descriptionStyle}>
                            Or open the bot directly:{" "}
                            <a href={s.bot_url} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                              {s.bot_url}
                            </a>
                          </p>
                          <p style={hintStyle}>Waiting for confirmation… (auto-detected)</p>
                          <button
                            type="button"
                            onClick={() => {
                              stopPoll()
                              setPinState(null)
                            }}
                            style={ghostButtonStyle}
                          >
                            Cancel
                          </button>
                        </div>
                      )
                    }}
                  </Show>
                </Match>
                <Match when={mode() === "account"}>
                  <form onSubmit={submitAccount} aria-label={accountMode() === "signup" ? "Sign up" : "Sign in"}>
                    <label style={labelStyle}>
                      <span>Username</span>
                      <input
                        type="text"
                        required
                        minlength="3"
                        maxlength="32"
                        pattern="[a-zA-Z0-9_.\\-]+"
                        value={accUsername()}
                        onInput={(e) => setAccUsername(e.currentTarget.value)}
                        autocomplete="username"
                        style={inputStyle}
                        placeholder="your_handle"
                      />
                    </label>
                    <label style={labelStyle}>
                      <span>Password</span>
                      <input
                        type="password"
                        required
                        minlength="8"
                        value={accPassword()}
                        onInput={(e) => setAccPassword(e.currentTarget.value)}
                        autocomplete={accountMode() === "signup" ? "new-password" : "current-password"}
                        style={inputStyle}
                        placeholder={accountMode() === "signup" ? "Pick something ≥ 8 chars" : "Your password"}
                      />
                    </label>
                    <Show when={accountMode() === "signup"}>
                      <label style={labelStyle}>
                        <span>Telegram handle (optional, for team invites)</span>
                        <input
                          type="text"
                          value={accTelegram()}
                          onInput={(e) => setAccTelegram(e.currentTarget.value)}
                          style={inputStyle}
                          placeholder="@yourhandle"
                        />
                      </label>
                    </Show>
                    <button type="submit" disabled={submitting()} style={primaryButtonStyle}>
                      {submitting()
                        ? accountMode() === "signup"
                          ? "Creating account…"
                          : "Signing in…"
                        : accountMode() === "signup"
                        ? "Create account"
                        : "Sign in"}
                    </button>
                    <p style={toggleModeStyle}>
                      {accountMode() === "signup" ? "Already have an account?" : "Don't have an account?"}{" "}
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          setAccountMode(accountMode() === "signup" ? "signin" : "signup")
                          setError(null)
                        }}
                        style={linkStyle}
                      >
                        {accountMode() === "signup" ? "Sign in" : "Sign up"}
                      </a>
                    </p>
                  </form>
                </Match>
              </Switch>

              <Show when={error()}>
                {(msg) => (
                  <p data-slot="error" style={errorStyle}>
                    {msg()}
                  </p>
                )}
              </Show>

              <p style={hintStyle}>Credentials stay in your browser's localStorage and travel only over HTTPS.</p>
              <p style={footerLinksStyle}>
                <a href="/home" style={footerLinkStyle}>Home</a>
                <span style={dotStyle}>·</span>
                <a href="/guide" style={footerLinkStyle}>Guide</a>
                <span style={dotStyle}>·</span>
                <a href="/pricing" style={footerLinkStyle}>Pricing</a>
                <span style={dotStyle}>·</span>
                <a href="/faq" style={footerLinkStyle}>FAQ</a>
                <span style={dotStyle}>·</span>
                <a href="/terms" style={footerLinkStyle}>Terms</a>
                <span style={dotStyle}>·</span>
                <a href="/privacy" style={footerLinkStyle}>Privacy</a>
              </p>
            </div>
          </div>
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

// ───────────────────────────────────────────────────────────────────────
// Inline styles (no theme deps so the gate renders standalone).
// ───────────────────────────────────────────────────────────────────────

const loadingStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "min-height": "100vh",
  "font-family": "system-ui, -apple-system, sans-serif",
  color: "#ccc",
  background: "#07070a",
}
const formStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "min-height": "100vh",
  padding: "24px",
  background: "radial-gradient(ellipse at top, #1a0a0a 0%, #07070a 70%)",
  "font-family": "system-ui, -apple-system, sans-serif",
}
const cardStyle: JSX.CSSProperties = {
  width: "100%",
  "max-width": "440px",
  padding: "32px",
  background: "rgba(15,15,20,0.9)",
  border: "1px solid rgba(255,87,34,0.3)",
  "border-radius": "14px",
  "box-shadow": "0 20px 60px rgba(0,0,0,0.5)",
}
const titleStyle: JSX.CSSProperties = {
  margin: "0 0 8px 0",
  "font-size": "24px",
  "font-weight": "800",
  color: "#fff",
}
const subtitleStyle: JSX.CSSProperties = {
  margin: "0 0 18px 0",
  "font-size": "14px",
  color: "rgba(255,255,255,0.55)",
}
const tabsStyle: JSX.CSSProperties = {
  display: "flex",
  gap: "8px",
  "margin-bottom": "18px",
}
const tabStyle = (active: boolean): JSX.CSSProperties => ({
  flex: "1",
  "min-height": "44px",
  padding: "10px 14px",
  background: active ? "rgba(255,87,34,0.15)" : "transparent",
  border: `1px solid ${active ? "rgba(255,87,34,0.5)" : "rgba(255,255,255,0.1)"}`,
  color: active ? "#ff5722" : "#d0d0d5",
  "border-radius": "8px",
  cursor: "pointer",
  "font-size": "13px",
  "font-weight": "600",
})
const descriptionStyle: JSX.CSSProperties = {
  margin: "0 0 14px 0",
  "font-size": "13px",
  color: "rgba(255,255,255,0.8)",
  "line-height": "1.55",
}
const labelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
  "margin-bottom": "14px",
  "font-size": "12px",
  color: "rgba(255,255,255,0.7)",
  "font-weight": "600",
}
const inputStyle: JSX.CSSProperties = {
  padding: "11px 14px",
  background: "#07070a",
  border: "1px solid rgba(255,255,255,0.15)",
  "border-radius": "8px",
  color: "#fff",
  "font-size": "14px",
  "font-family": "inherit",
  outline: "none",
}
const primaryButtonStyle: JSX.CSSProperties = {
  width: "100%",
  "min-height": "44px",
  padding: "12px",
  background: "linear-gradient(135deg, #ff5722, #f4511e)",
  color: "#fff",
  border: "none",
  "border-radius": "8px",
  "font-size": "14px",
  "font-weight": "700",
  cursor: "pointer",
}
const ghostButtonStyle: JSX.CSSProperties = {
  width: "100%",
  "min-height": "44px",
  padding: "10px",
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ccc",
  "border-radius": "8px",
  cursor: "pointer",
  "font-size": "13px",
  "margin-top": "8px",
}
const pinStyle: JSX.CSSProperties = {
  "font-family": "ui-monospace, Menlo, Consolas, monospace",
  "font-size": "32px",
  "font-weight": "800",
  "letter-spacing": "0.2em",
  color: "#ff5722",
  "text-align": "center",
  padding: "20px",
  margin: "12px 0",
  background: "rgba(255,87,34,0.08)",
  border: "1px dashed rgba(255,87,34,0.4)",
  "border-radius": "10px",
  "user-select": "all",
}
const linkStyle: JSX.CSSProperties = {
  color: "#ff5722",
  "text-decoration": "none",
  "word-break": "break-all",
}
const errorStyle: JSX.CSSProperties = {
  margin: "14px 0 0 0",
  padding: "10px 12px",
  background: "rgba(255,0,0,0.08)",
  border: "1px solid rgba(255,0,0,0.25)",
  "border-radius": "6px",
  color: "#ff8a8a",
  "font-size": "13px",
}
const hintStyle: JSX.CSSProperties = {
  margin: "18px 0 0 0",
  "font-size": "11px",
  color: "rgba(255,255,255,0.4)",
  "line-height": "1.5",
}
const footerLinksStyle: JSX.CSSProperties = {
  margin: "14px 0 0 0",
  "text-align": "center",
  "font-size": "11px",
}
const footerLinkStyle: JSX.CSSProperties = {
  color: "rgba(255,255,255,0.55)",
  "text-decoration": "none",
  margin: "0 4px",
}
const dotStyle: JSX.CSSProperties = {
  color: "rgba(255,255,255,0.25)",
}
const toggleModeStyle: JSX.CSSProperties = {
  "text-align": "center",
  margin: "14px 0 0 0",
  "font-size": "13px",
  color: "rgba(255,255,255,0.6)",
}
const newHereStyle: JSX.CSSProperties = {
  display: "block",
  "margin-bottom": "16px",
  padding: "10px 14px",
  background: "rgba(255,87,34,0.08)",
  border: "1px solid rgba(255,87,34,0.25)",
  "border-radius": "8px",
  color: "#ff8a4a",
  "text-decoration": "none",
  "font-size": "13px",
  "font-weight": "600",
  "text-align": "center",
}
