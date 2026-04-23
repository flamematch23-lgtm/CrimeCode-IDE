import { Match, Show, Switch, createResource, createSignal } from "solid-js"
import { useLicense } from "./use-license"

interface SignInState {
  pin: string
  bot_url: string
  expires_at: number
}

export function AccountModal(props: { onClose: () => void }) {
  const [account, { refetch }] = createResource(() => window.api.account.get())
  const [signIn, setSignIn] = createSignal<SignInState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [polling, setPolling] = createSignal(false)
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
    setBusy(true)
    setErr(null)
    try {
      const s = await window.api.account.startSignIn()
      setSignIn(s)
      setPolling(true)
      // Open the bot deep-link automatically.
      window.api.openLink(s.bot_url)
      // Poll every 2s for up to the PIN's TTL.
      pollTimer = setInterval(async () => {
        try {
          const session = await window.api.account.pollSignIn(s.pin)
          if (session) {
            stopPoll()
            setSignIn(null)
            await refetch()
            await refreshLicense()
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
      setBusy(false)
    }
  }

  async function logout() {
    if (busy()) return
    setBusy(true)
    setErr(null)
    try {
      await window.api.account.logout()
      await refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
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
                    <a href={s.bot_url} onClick={(e) => { e.preventDefault(); window.api.openLink(s.bot_url) }}>
                      {s.bot_url}
                    </a>
                  </p>
                  <p data-slot="hint">Waiting for confirmation… (auto-detected)</p>
                  <button data-kind="ghost" onClick={() => { stopPoll(); setSignIn(null) }}>Cancel</button>
                </div>
              )
            }}
          </Match>

          <Match when={account()}>
            {(s) => (
              <div data-slot="signed-in">
                <p data-slot="ok">✓ Signed in</p>
                <dl>
                  <dt>Customer ID</dt><dd><code>{s().customer_id}</code></dd>
                  <Show when={s().telegram_user_id}>
                    <dt>Telegram user ID</dt><dd><code>{s().telegram_user_id}</code></dd>
                  </Show>
                  <dt>Session expires</dt>
                  <dd>{new Date(s().expires_at * 1000).toLocaleString()}</dd>
                </dl>
                <button data-kind="danger" onClick={logout} disabled={busy()}>Sign out</button>
              </div>
            )}
          </Match>

          <Match when={!account.loading && !account()}>
            <div data-slot="signed-out">
              <p>You're not signed in. Sign in to sync your license across devices and unlock account-level features.</p>
              <button data-kind="primary" onClick={startSignIn} disabled={busy()}>
                Sign in via Telegram
              </button>
            </div>
          </Match>
        </Switch>

        <Show when={err()}>{(msg) => <p data-slot="error">⚠️ {msg()}</p>}</Show>
      </div>
    </div>
  )
}
