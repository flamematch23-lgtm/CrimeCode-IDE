import { createSignal, Show, Switch, Match, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import {
  fetchApprovalStatus,
  readWebSession,
  signInWithAccount,
  signUpWithAccount,
  writeWebSession,
  logout as logoutSession,
} from "../utils/teams-client"
import { applyCloudLicenseIfDesktop, configureCloudSyncIfDesktop } from "../utils/cloud-sync"
import { clearStoredReferral, readStoredReferral } from "./referral-landing"

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
  // Use proper base64 encoding that works in both browser and Node.js/Bun
  const credentials = `${creds.username}:${creds.password}`
  let encoded: string
  if (typeof btoa === "function") {
    encoded = btoa(credentials)
  } else {
    encoded = Buffer.from(credentials).toString("base64")
  }
  return "Basic " + encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
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
  const isDesktop = typeof (window as any).api?.account?.startSignIn === "function"
  if (isDesktop) {
    const res = await (window as any).api.account.startSignIn()
    return res
  }
  const res = await fetch(`${DEFAULT_URL}/license/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_label: navigator.userAgent.slice(0, 80) }),
  })
  if (!res.ok) throw new Error(`auth/start ${res.status}`)
  return (await res.json()) as PinState
}

async function pollTgAuth(
  pin: string,
): Promise<
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ok"; token: string; exp: number; customer_id: string }
  | { status: "unknown" }
  | { status: "awaiting_approval"; customer_id: string }
  | { status: "rejected"; customer_id: string; rejected_reason?: string | null }
> {
  const isDesktop = typeof (window as any).api?.account?.pollSignIn === "function"
  if (isDesktop) {
    const session = await (window as any).api.account.pollSignIn(pin)
    if (session) {
      return { status: "ok", token: session.token, exp: session.expires_at, customer_id: session.customer_id }
    }
    return { status: "pending" }
  }
  const res = await fetch(`${DEFAULT_URL}/license/auth/poll/${encodeURIComponent(pin)}`)
  if (!res.ok) throw new Error(`auth/poll ${res.status}`)
  return (await res.json()) as never
}

/**
 * Read a referral code from either the URL (?ref=ABCD…) or from the
 * localStorage stash that the /r/<CODE> landing page wrote. URL wins
 * because a freshly-clicked link should override an old stale stash.
 */
function readInitialReferral(): string {
  if (typeof window === "undefined") return ""
  try {
    const url = new URL(window.location.href)
    const fromQuery = (url.searchParams.get("ref") ?? "").trim().toUpperCase()
    if (fromQuery && /^[A-Z0-9]{4,32}$/.test(fromQuery)) return fromQuery
  } catch {
    /* ignore */
  }
  return readStoredReferral() ?? ""
}

async function resolveReferral(
  code: string,
): Promise<{ valid: false } | { valid: true; bonus_for_you: number; bonus_for_them: number }> {
  const res = await fetch(`${DEFAULT_URL}/account/me/resolve-referral?code=${encodeURIComponent(code)}`)
  if (!res.ok) return { valid: false }
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
  // Referral code: prefilled from localStorage (set by /r/<CODE> landing) or
  // from a ?ref=<CODE> query param so deep-link survives even if the visitor
  // skipped the landing page entirely.
  const [accReferral, setAccReferral] = createSignal(readInitialReferral())
  // Live "this code is valid" status hint, populated by GET /resolve-referral.
  const [referralStatus, setReferralStatus] = createSignal<
    null | { kind: "valid"; bonusForYou: number; bonusForThem: number } | { kind: "invalid" } | { kind: "checking" }
  >(null)
  const [submitting, setSubmitting] = createSignal(false)

  /**
   * Set when the server says "you're authenticated but the admin hasn't
   * approved you yet". The client parks on the pending screen and polls
   * /auth/status until the admin decides — then auto-completes the
   * sign-in with the stashed credentials so the user doesn't have to
   * re-type anything.
   */
  interface PendingState {
    customer_id: string
    username: string
    password: string
    started_at: number
    /** set to true when admin rejects, so we can render the final state. */
    rejected?: boolean
    rejected_reason?: string | null
  }
  const [pendingApproval, setPendingApproval] = createSignal<PendingState | null>(null)
  let approvalTimer: ReturnType<typeof setInterval> | null = null
  function stopApprovalPolling() {
    if (approvalTimer) {
      clearInterval(approvalTimer)
      approvalTimer = null
    }
  }
  onCleanup(stopApprovalPolling)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    setPolling(false)
  }
  onCleanup(stopPoll)

  // If a referral was pre-filled, switch the form straight to "Crea account"
  // mode and resolve the code so the user sees the live "+3 days bonus"
  // confirmation. Saves a click on the toggle and primes social-proof copy.
  onMount(() => {
    const ref = accReferral()
    if (ref) {
      setMode("account")
      setAccountMode("signup")
      void liveCheckReferral(ref)
    }
  })

  let referralDebounce: ReturnType<typeof setTimeout> | null = null
  function onReferralInput(value: string) {
    const trimmed = value.trim().toUpperCase()
    setAccReferral(trimmed)
    setReferralStatus(null)
    if (referralDebounce) clearTimeout(referralDebounce)
    if (!trimmed) return
    if (!/^[A-Z0-9]{4,32}$/.test(trimmed)) {
      setReferralStatus({ kind: "invalid" })
      return
    }
    setReferralStatus({ kind: "checking" })
    referralDebounce = setTimeout(() => {
      void liveCheckReferral(trimmed)
    }, 350)
  }

  async function liveCheckReferral(code: string) {
    try {
      const r = await resolveReferral(code)
      if (r.valid) {
        setReferralStatus({ kind: "valid", bonusForYou: r.bonus_for_you, bonusForThem: r.bonus_for_them })
      } else {
        setReferralStatus({ kind: "invalid" })
      }
    } catch {
      setReferralStatus({ kind: "invalid" })
    }
  }

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
            void configureCloudSyncIfDesktop(r.token)
            void applyCloudLicenseIfDesktop(r.token)
            setPinState(null)
          }
          if (r.status === "awaiting_approval") {
            stopPoll()
            setPinState(null)
            setPendingApproval({
              customer_id: r.customer_id,
              username: "",
              password: "",
              started_at: Math.floor(Date.now() / 1000),
            })
            startApprovalPollingForTelegram(r.customer_id, s.pin)
          }
          if (r.status === "rejected") {
            stopPoll()
            setPinState(null)
            setPendingApproval({
              customer_id: r.customer_id,
              username: "",
              password: "",
              started_at: Math.floor(Date.now() / 1000),
              rejected: true,
              rejected_reason: r.rejected_reason ?? null,
            })
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
      account_rejected: "Your access request has been rejected. Contact @OpCrime1312.",
      account_pending_approval: "Your account is waiting for admin approval.",
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
      const result = await fn({
        username: trimmedUser,
        password: accPassword(),
        ...(accountMode() === "signup" && accTelegram().trim() ? { telegram: accTelegram().trim() } : {}),
        ...(accountMode() === "signup" && accReferral().trim() ? { referral_code: accReferral().trim() } : {}),
        device_label: `web (${navigator.userAgent.slice(0, 60)})`,
      })
      // Whatever happens after a successful signup, the stashed referral
      // code has now done its job — clear it so a future returning visitor
      // doesn't re-redeem on a different account.
      if (accountMode() === "signup" && accReferral().trim()) {
        clearStoredReferral()
      }
      if (result.status === "pending") {
        // Admin hasn't approved yet — park on the pending screen and
        // poll /auth/status until the decision lands.
        setPendingApproval({
          customer_id: result.customer_id,
          username: trimmedUser,
          password: accPassword(),
          started_at: Math.floor(Date.now() / 1000),
        })
        startApprovalPolling(result.customer_id)
        return
      }
      writeWebSession({
        token: result.token,
        customer_id: result.customer_id,
        telegram_user_id: null,
        expires_at: result.exp,
      })
      const next: Credentials = {
        url: DEFAULT_URL,
        username: "bearer",
        password: result.token,
        kind: "bearer",
      }
      writeCredentials(next)
      setCreds(next)
      void configureCloudSyncIfDesktop(result.token)
      void applyCloudLicenseIfDesktop(result.token)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(friendlyAuthError(msg))
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Poll /auth/status every 5s. On `approved`, silently re-submit
   * /auth/signin with the stashed credentials so we get a real session
   * token and drop the user straight into the app. On `rejected`, show
   * the outcome and clear stashed credentials.
   */
  function startApprovalPolling(customerId: string) {
    stopApprovalPolling()
    approvalTimer = setInterval(async () => {
      try {
        const s = await fetchApprovalStatus(customerId)
        if (s.status === "approved") {
          stopApprovalPolling()
          const pending = pendingApproval()
          if (!pending) return
          try {
            const result = await signInWithAccount({
              username: pending.username,
              password: pending.password,
              device_label: `web (${navigator.userAgent.slice(0, 60)})`,
            })
            // Clear stashed credentials no matter what happens next.
            setPendingApproval(null)
            if (result.status === "pending") {
              // Race with the server — keep polling just in case.
              setPendingApproval({ ...pending })
              startApprovalPolling(customerId)
              return
            }
            writeWebSession({
              token: result.token,
              customer_id: result.customer_id,
              telegram_user_id: null,
              expires_at: result.exp,
            })
            const next: Credentials = {
              url: DEFAULT_URL,
              username: "bearer",
              password: result.token,
              kind: "bearer",
            }
            writeCredentials(next)
            setCreds(next)
            void configureCloudSyncIfDesktop(result.token)
            void applyCloudLicenseIfDesktop(result.token)
      void applyCloudLicenseIfDesktop(result.token)
          } catch (err) {
            setError(friendlyAuthError(err instanceof Error ? err.message : String(err)))
          }
        } else if (s.status === "rejected") {
          stopApprovalPolling()
          setPendingApproval((p) => (p ? { ...p, rejected: true, rejected_reason: s.rejected_reason ?? null } : p))
        }
        // pending → keep polling
      } catch {
        // Transient network error — keep polling.
      }
    }, 5000)
  }

  function cancelApprovalWait() {
    stopApprovalPolling()
    setPendingApproval(null)
    setError(null)
  }

  /**
   * Variant of startApprovalPolling for the Telegram flow — instead of
   * re-submitting credentials we re-poll the original PIN. Once the
   * server flips the customer to "approved" the next /auth/poll/<pin>
   * will return status:"ok" with a real session token.
   */
  function startApprovalPollingForTelegram(customerId: string, pin: string) {
    stopApprovalPolling()
    approvalTimer = setInterval(async () => {
      try {
        const s = await fetchApprovalStatus(customerId)
        if (s.status === "approved") {
          stopApprovalPolling()
          // One last PIN poll to claim the freshly-issued token.
          try {
            const r = await pollTgAuth(pin)
            if (r.status === "ok") {
              setPendingApproval(null)
              writeWebSession({
                token: r.token,
                customer_id: r.customer_id,
                telegram_user_id: null,
                expires_at: r.exp,
              })
              const next: Credentials = {
                url: DEFAULT_URL,
                username: "bearer",
                password: r.token,
                kind: "bearer",
              }
              writeCredentials(next)
              setCreds(next)
              void configureCloudSyncIfDesktop(r.token)
            void applyCloudLicenseIfDesktop(r.token)
            } else {
              // Pin already consumed or expired — point the user back
              // to the Telegram tab so they grab a fresh PIN.
              setPendingApproval(null)
              setError("Approvazione ricevuta. Avvia di nuovo il sign-in con Telegram per ottenere il token.")
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        } else if (s.status === "rejected") {
          stopApprovalPolling()
          setPendingApproval((p) => (p ? { ...p, rejected: true, rejected_reason: s.rejected_reason ?? null } : p))
        }
      } catch {
        // transient — keep polling
      }
    }, 5000)
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
          <Show when={pendingApproval()}>
            {(p) => (
              <div data-auth-gate="pending" style={formStyle}>
                <div style={cardStyle}>
                  <Show
                    when={p().rejected}
                    fallback={
                      <>
                        <div style={pendingHeroStyle} aria-hidden="true">
                          ⏳
                        </div>
                        <h1 style={titleStyle}>Account in attesa di approvazione</h1>
                        <p style={subtitleStyle}>
                          La tua registrazione è stata ricevuta. L'amministratore deve confermare il tuo accesso prima
                          che la prova gratuita parta.
                        </p>
                        <ul style={pendingListStyle}>
                          <li>✅ Notifica inviata all'admin su Telegram</li>
                          <li>⏱️ Di solito l'approvazione arriva in pochi minuti</li>
                          <li>
                            💬 Per accelerare contatta <b>@OpCrime1312</b>
                          </li>
                        </ul>
                        <p style={pendingMutedStyle}>
                          Customer ID: <code style={{ "font-size": "12px" }}>{p().customer_id}</code>
                        </p>
                        <div style={{ display: "flex", "justify-content": "center", "margin-top": "16px" }}>
                          <span style={pendingDotStyle} />
                          <span style={pendingDotStyle} />
                          <span style={pendingDotStyle} />
                        </div>
                        <button type="button" style={pendingCancelStyle} onClick={cancelApprovalWait}>
                          ← Torna indietro
                        </button>
                      </>
                    }
                  >
                    <div style={{ ...pendingHeroStyle, color: "#ff6b6b" }} aria-hidden="true">
                      ⛔
                    </div>
                    <h1 style={titleStyle}>Accesso rifiutato</h1>
                    <p style={subtitleStyle}>L'amministratore non ha approvato la tua richiesta di accesso.</p>
                    <Show when={p().rejected_reason}>
                      <p style={pendingReasonStyle}>"{p().rejected_reason}"</p>
                    </Show>
                    <p style={pendingMutedStyle}>
                      Per chiarimenti scrivi a <b>@OpCrime1312</b>.
                    </p>
                    <button type="button" style={pendingCancelStyle} onClick={cancelApprovalWait}>
                      ← Torna al sign-in
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </Show>
          <Show when={!pendingApproval()}>
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
                        <label style={labelStyle}>
                          <span>Referral code (optional)</span>
                          <input
                            type="text"
                            value={accReferral()}
                            onInput={(e) => onReferralInput(e.currentTarget.value)}
                            style={inputStyle}
                            placeholder="e.g. SHQX3J5X"
                            maxlength="32"
                            autocomplete="off"
                          />
                          <Show
                            when={
                              referralStatus()?.kind === "valid"
                                ? (referralStatus() as { kind: "valid"; bonusForYou: number; bonusForThem: number })
                                : null
                            }
                          >
                            {(s) => (
                              <span data-slot="referral-ok" style={referralOkStyle}>
                                🎁 Valid! You'll get <strong>+{s().bonusForYou} bonus trial days</strong> on top
                                of your free trial.
                              </span>
                            )}
                          </Show>
                          <Show when={referralStatus()?.kind === "checking"}>
                            <span style={referralCheckingStyle}>Checking…</span>
                          </Show>
                          <Show when={referralStatus()?.kind === "invalid" && accReferral().length > 0}>
                            <span data-slot="referral-bad" style={referralBadStyle}>
                              That code doesn't exist. You can leave it empty.
                            </span>
                          </Show>
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
                  <a href="/home" style={footerLinkStyle}>
                    Home
                  </a>
                  <span style={dotStyle}>·</span>
                  <a href="/guide" style={footerLinkStyle}>
                    Guide
                  </a>
                  <span style={dotStyle}>·</span>
                  <a href="/pricing" style={footerLinkStyle}>
                    Pricing
                  </a>
                  <span style={dotStyle}>·</span>
                  <a href="/faq" style={footerLinkStyle}>
                    FAQ
                  </a>
                  <span style={dotStyle}>·</span>
                  <a href="/terms" style={footerLinkStyle}>
                    Terms
                  </a>
                  <span style={dotStyle}>·</span>
                  <a href="/privacy" style={footerLinkStyle}>
                    Privacy
                  </a>
                </p>
              </div>
            </div>
          </Show>
        </Show>
      }
    >
      {(c) => props.children(c())}
    </Show>
  )
}

export async function logout(): Promise<void> {
  await logoutSession()
  window.location.reload()
}

// ───────────────────────────────────────────────────────────────────────
// Inline styles (no theme deps so the gate renders standalone).
// ───────────────────────────────────────────────────────────────────────

const pendingHeroStyle: JSX.CSSProperties = {
  "font-size": "56px",
  "text-align": "center",
  "margin-bottom": "12px",
  filter: "drop-shadow(0 0 16px rgba(255, 87, 34, 0.4))",
}

const pendingListStyle: JSX.CSSProperties = {
  "list-style": "none",
  padding: "16px 18px",
  margin: "16px 0",
  background: "rgba(255, 87, 34, 0.06)",
  border: "1px solid rgba(255, 87, 34, 0.18)",
  "border-radius": "10px",
  "font-size": "13px",
  "line-height": "2",
  color: "#ddd",
}

const pendingMutedStyle: JSX.CSSProperties = {
  "font-size": "11px",
  color: "rgba(255, 255, 255, 0.45)",
  "text-align": "center",
  "margin-top": "8px",
}

const pendingReasonStyle: JSX.CSSProperties = {
  "font-style": "italic",
  color: "#ff8a8a",
  background: "rgba(255, 0, 0, 0.06)",
  border: "1px solid rgba(255, 0, 0, 0.18)",
  "border-radius": "8px",
  padding: "10px 14px",
  margin: "12px 0",
  "text-align": "center",
}

const pendingDotStyle: JSX.CSSProperties = {
  width: "8px",
  height: "8px",
  background: "#ff5722",
  "border-radius": "50%",
  margin: "0 4px",
  animation: "pulse-dot 1.4s ease-in-out infinite",
}

const pendingCancelStyle: JSX.CSSProperties = {
  display: "block",
  margin: "20px auto 0",
  background: "transparent",
  border: "none",
  color: "rgba(255, 255, 255, 0.55)",
  "font-size": "12px",
  cursor: "pointer",
  "text-decoration": "underline",
}

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
const referralOkStyle: JSX.CSSProperties = {
  display: "block",
  "margin-top": "6px",
  padding: "6px 10px",
  background: "rgba(80, 200, 120, 0.10)",
  border: "1px solid rgba(80, 200, 120, 0.35)",
  "border-radius": "6px",
  color: "#7adf9c",
  "font-size": "12px",
  "line-height": "1.4",
}
const referralBadStyle: JSX.CSSProperties = {
  display: "block",
  "margin-top": "6px",
  "font-size": "12px",
  color: "rgba(255, 138, 138, 0.85)",
}
const referralCheckingStyle: JSX.CSSProperties = {
  display: "block",
  "margin-top": "6px",
  "font-size": "12px",
  color: "rgba(255,255,255,0.45)",
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
