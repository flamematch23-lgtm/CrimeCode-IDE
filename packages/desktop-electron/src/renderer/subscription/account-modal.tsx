import { Match, Show, Switch, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useLicense } from "./use-license"
import { lastSyncAt, pullAll, pushAll } from "./sync-manager"
import { signInWithAccount, signUpWithAccount, writeWebSession } from "@opencode-ai/app/utils/teams-client"
import { installFocusTrap } from "../a11y/focus-trap"

interface SignInState {
  pin: string
  bot_url: string
  expires_at: number
}

function formatSyncAt(ts: number | null): string {
  if (!ts) return "never"
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`
  return new Date(ts * 1000).toLocaleString()
}

async function loadAndMirrorSession() {
  const session = await window.api.account.get()
  writeWebSession(
    session
      ? {
          token: session.token,
          customer_id: session.customer_id,
          telegram_user_id: session.telegram_user_id,
          expires_at: session.expires_at,
        }
      : null,
  )
  return session
}

export function AccountModal(props: { onClose: () => void }) {
  const [account, { refetch }] = createResource(loadAndMirrorSession)
  const [signIn, setSignIn] = createSignal<SignInState | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [info, setInfo] = createSignal<string | null>(null)
  const [polling, setPolling] = createSignal(false)
  const [lastSync, setLastSync] = createSignal(lastSyncAt())
  const [accountMode, setAccountMode] = createSignal<"signin" | "signup">("signin")
  const [accUsername, setAccUsername] = createSignal("")
  const [accPassword, setAccPassword] = createSignal("")
  const [accTelegram, setAccTelegram] = createSignal("")
  const { refresh: refreshLicense } = useLicense()

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    setPolling(false)
  }

  async function startSignIn() {
    if (busy()) return
    setBusy("signin")
    setErr(null)
    setInfo(null)
    try {
      const s = await window.api.account.startSignIn()
      setSignIn(s)
      setPolling(true)
      window.api.openLink(s.bot_url)
      pollTimer = setInterval(async () => {
        try {
          const session = await window.api.account.pollSignIn(s.pin)
          if (session) {
            stopPoll()
            setSignIn(null)
            await refetch()
            await refreshLicense()
            // Auto-pull the cloud snapshot right after a successful sign-in
            // so a new device immediately shows the user's settings + recents.
            const r = await pullAll()
            if (r.ok) {
              setLastSync(lastSyncAt())
              setInfo(`Pulled cloud snapshot (${r.pulledRecents ?? 0} projects)`)
            }
          }
          if (Math.floor(Date.now() / 1000) > s.expires_at) {
            stopPoll()
            setSignIn(null)
            setErr("PIN expired. Try again.")
          }
        } catch (e) {
          stopPoll()
          setSignIn(null)
          setErr(e instanceof Error ? e.message : String(e))
        }
      }, 2000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function logout() {
    if (busy()) return
    setBusy("logout")
    setErr(null)
    setInfo(null)
    try {
      await window.api.account.logout()
      await refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function doPush() {
    if (busy()) return
    setBusy("push")
    setErr(null)
    setInfo(null)
    try {
      const r = await pushAll()
      if (r.ok) {
        setLastSync(lastSyncAt())
        setInfo("✓ Backup uploaded to cloud")
      } else {
        setErr(r.error ?? "backup failed")
      }
    } finally {
      setBusy(null)
    }
  }

  function friendlyAuthError(code: string): string {
    const map: Record<string, string> = {
      invalid_username: "Username must be 3–32 chars (letters, digits, _ - .).",
      invalid_password: "Password must be at least 8 characters.",
      username_taken: "That username is already in use. Try signing in.",
      invalid_credentials: "Wrong username or password.",
      account_revoked: "This account has been disabled. Contact @OpCrime1312.",
      missing_credentials: "Enter both a username and a password.",
      rate_limited: "Too many attempts. Try again in a minute.",
    }
    return map[code] ?? code
  }

  async function submitAccount(e: Event) {
    e.preventDefault()
    if (busy()) return
    setBusy("account")
    setErr(null)
    setInfo(null)
    try {
      const fn = accountMode() === "signup" ? signUpWithAccount : signInWithAccount
      const result = await fn({
        username: accUsername().trim(),
        password: accPassword(),
        ...(accountMode() === "signup" && accTelegram().trim()
          ? { telegram: accTelegram().trim() }
          : {}),
        device_label: "desktop app",
      })
      // Approval gate (v2.21.0): when the admin hasn't OK'd this account yet
      // we get a pending marker instead of a session. Surface it as info
      // text so the user knows to wait — no token, no trial, no app access.
      if (result.status === "pending") {
        setInfo(
          "Account in attesa di approvazione. L'admin riceverà la notifica su Telegram. " +
            "Riprova ad accedere quando ti arriva la conferma. Customer ID: " +
            result.customer_id,
        )
        return
      }
      writeWebSession({
        token: result.token,
        customer_id: result.customer_id,
        telegram_user_id: null,
        expires_at: result.exp,
      })
      // The desktop stores its session in electron-store via IPC. Since the
      // Electron main process owns that store we can't write it from the
      // renderer, but the same shared fetch helpers used for cloud sync
      // read from localStorage so the user's already signed in from the
      // SSE/teams perspective. We only need to kick the account resource
      // to re-read.
      await refetch()
      await refreshLicense()
      setInfo(accountMode() === "signup" ? "Account created." : "Signed in.")
      setAccUsername("")
      setAccPassword("")
      setAccTelegram("")
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : String(ex)
      setErr(friendlyAuthError(msg))
    } finally {
      setBusy(null)
    }
  }

  async function doPull() {
    if (busy()) return
    setBusy("pull")
    setErr(null)
    setInfo(null)
    try {
      const r = await pullAll()
      if (r.ok) {
        setLastSync(lastSyncAt())
        setInfo(
          `✓ Restored from cloud (settings: ${r.pulledSettings ? "yes" : "no"}, projects: ${r.pulledRecents ?? 0})`,
        )
      } else {
        setErr(r.error ?? "restore failed")
      }
    } finally {
      setBusy(null)
    }
  }

  function close() {
    stopPoll()
    props.onClose()
  }

  let panelRef: HTMLDivElement | undefined
  onMount(() => {
    if (!panelRef) return
    const trap = installFocusTrap(panelRef, close)
    onCleanup(() => trap.release())
  })
  onCleanup(stopPoll)

  return (
    <div data-component="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title" ref={(el) => (panelRef = el)}>
      <div data-slot="backdrop" onClick={close} />
      <div data-slot="panel">
        <button data-slot="close" onClick={close} aria-label="Close">×</button>
        <h2 id="account-title">Account</h2>

        <Switch>
          <Match when={signIn() && polling()}>
            {(_) => {
              const s = signIn()!
              return (
                <div data-slot="signin-pending">
                  <p>Open Telegram and sign in with this one-time PIN:</p>
                  <div data-slot="pin">{s.pin}</div>
                  <p>
                    Or click here:{" "}
                    <a
                      href={s.bot_url}
                      onClick={(e) => {
                        e.preventDefault()
                        window.api.openLink(s.bot_url)
                      }}
                    >
                      {s.bot_url}
                    </a>
                  </p>
                  <p data-slot="hint">Waiting for confirmation… (auto-detected)</p>
                  <button
                    data-kind="ghost"
                    onClick={() => {
                      stopPoll()
                      setSignIn(null)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )
            }}
          </Match>

          <Match when={account()}>
            {(s) => (
              <div data-slot="signed-in">
                <p data-slot="ok">✓ Signed in</p>
                <dl>
                  <dt>Customer ID</dt>
                  <dd>
                    <code>{s().customer_id}</code>
                  </dd>
                  <Show when={s().telegram_user_id}>
                    <dt>Telegram user ID</dt>
                    <dd>
                      <code>{s().telegram_user_id}</code>
                    </dd>
                  </Show>
                  <dt>Session expires</dt>
                  <dd>{new Date(s().expires_at * 1000).toLocaleString()}</dd>
                </dl>

                <div data-slot="sync-section">
                  <h3>Cloud sync</h3>
                  <p data-slot="hint">Settings and recent projects are backed up per account. Last sync: <b>{formatSyncAt(lastSync())}</b>.</p>
                  <div data-slot="sync-actions">
                    <button data-kind="primary" onClick={doPush} disabled={!!busy()}>
                      📤 Backup to cloud
                    </button>
                    <button data-kind="ghost" onClick={doPull} disabled={!!busy()}>
                      📥 Restore from cloud
                    </button>
                  </div>
                </div>

                <button data-kind="danger" onClick={logout} disabled={!!busy()}>
                  Sign out
                </button>
              </div>
            )}
          </Match>

          <Match when={!account.loading && !account()}>
            <div data-slot="signed-out">
              <p>
                You're not signed in. Signing in unlocks teams, cross-device sync, and account-level features.
              </p>
              <button data-kind="primary" onClick={startSignIn} disabled={!!busy()}>
                📱 Sign in via Telegram
              </button>

              <div data-slot="or-separator"><span>or use an account</span></div>

              <form onSubmit={submitAccount} data-slot="account-form">
                <label>
                  <span>Username</span>
                  <input
                    type="text"
                    required
                    minlength="3"
                    maxlength="32"
                    pattern="[a-zA-Z0-9_.\-]+"
                    value={accUsername()}
                    onInput={(e) => setAccUsername(e.currentTarget.value)}
                    autocomplete="username"
                    placeholder="your_handle"
                    disabled={busy() === "account"}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    required
                    minlength="8"
                    value={accPassword()}
                    onInput={(e) => setAccPassword(e.currentTarget.value)}
                    autocomplete={accountMode() === "signup" ? "new-password" : "current-password"}
                    placeholder={accountMode() === "signup" ? "Pick something ≥ 8 chars" : "Your password"}
                    disabled={busy() === "account"}
                  />
                </label>
                <Show when={accountMode() === "signup"}>
                  <label>
                    <span>Telegram handle (optional)</span>
                    <input
                      type="text"
                      value={accTelegram()}
                      onInput={(e) => setAccTelegram(e.currentTarget.value)}
                      placeholder="@yourhandle"
                      disabled={busy() === "account"}
                    />
                  </label>
                </Show>
                <button data-kind="primary" type="submit" disabled={busy() === "account"}>
                  {busy() === "account"
                    ? accountMode() === "signup" ? "Creating…" : "Signing in…"
                    : accountMode() === "signup" ? "Create account" : "Sign in"}
                </button>
                <p data-slot="toggle-mode">
                  {accountMode() === "signup" ? "Already have an account?" : "Don't have an account?"}{" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      setAccountMode(accountMode() === "signup" ? "signin" : "signup")
                      setErr(null)
                    }}
                  >
                    {accountMode() === "signup" ? "Sign in" : "Sign up"}
                  </a>
                </p>
              </form>
            </div>
          </Match>
        </Switch>

        <Show when={info()}>{(msg) => <p data-slot="info">{msg()}</p>}</Show>
        <Show when={err()}>{(msg) => <p data-slot="error">⚠️ {msg()}</p>}</Show>
      </div>
    </div>
  )
}
