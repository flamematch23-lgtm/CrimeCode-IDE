import { Match, Show, Switch, createResource, createSignal } from "solid-js"
import { useLicense } from "./use-license"
import { lastSyncAt, pullAll, pushAll } from "./sync-manager"

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

export function AccountModal(props: { onClose: () => void }) {
  const [account, { refetch }] = createResource(() => window.api.account.get())
  const [signIn, setSignIn] = createSignal<SignInState | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [info, setInfo] = createSignal<string | null>(null)
  const [polling, setPolling] = createSignal(false)
  const [lastSync, setLastSync] = createSignal(lastSyncAt())
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

  return (
    <div data-component="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
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
                You're not signed in. Sign in to sync your settings and recent projects across devices and unlock
                account-level features.
              </p>
              <button data-kind="primary" onClick={startSignIn} disabled={!!busy()}>
                Sign in via Telegram
              </button>
            </div>
          </Match>
        </Switch>

        <Show when={info()}>{(msg) => <p data-slot="info">{msg()}</p>}</Show>
        <Show when={err()}>{(msg) => <p data-slot="error">⚠️ {msg()}</p>}</Show>
      </div>
    </div>
  )
}
