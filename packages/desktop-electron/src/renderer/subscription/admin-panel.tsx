import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { t } from "../i18n"
import { useLicense } from "./use-license"
import type { LicenseSnapshot, ProInterval } from "../../preload/types"

const INTERVALS: ProInterval[] = ["monthly", "annual", "lifetime"]
const LICENSE_POLL_INTERVAL_MS = 5_000
const LOG_CAPACITY = 20

type LogEntry = { timestamp: string; action: string; result: string }

const formatIso = (iso: string | null | undefined): string => {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

const truncateToken = (token: string | null | undefined): string => {
  if (!token) return "—"
  if (token.length <= 10) return token
  return `${token.slice(0, 3)}…${token.slice(-3)}`
}

const formatSnapshotResult = (snapshot: LicenseSnapshot | null | undefined): string => {
  if (!snapshot) return "ok"
  const interval = snapshot.interval ?? "—"
  return `status: ${snapshot.effectiveStatus}, interval: ${interval}`
}

const formatErrorResult = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return `error: ${msg}`
}

const nowClockString = (): string => {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function AdminPanel(props: { onClose: () => void }) {
  const { license, refresh } = useLicense()
  const [status, { refetch }] = createResource(() => window.api.admin.status())
  const [passphrase, setPassphrase] = createSignal("")
  const [err, setErr] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [log, setLog] = createSignal<LogEntry[]>([])

  const isDev = import.meta.env.DEV

  const pushLog = (action: string, result: string) => {
    setLog((entries) => {
      const next: LogEntry[] = [{ timestamp: nowClockString(), action, result }, ...entries]
      if (next.length > LOG_CAPACITY) next.length = LOG_CAPACITY
      return next
    })
  }

  // Auto-refresh the license + admin status every 5s while the panel is mounted.
  const pollId = setInterval(() => {
    refresh()
    void refetch()
  }, LICENSE_POLL_INTERVAL_MS)
  onCleanup(() => clearInterval(pollId))

  async function onUnlock(e?: Event) {
    e?.preventDefault()
    if (busy() || !passphrase()) return
    setBusy(true)
    setErr(null)
    const input = passphrase()
    try {
      const result = await window.api.admin.unlock(input)
      if (!result.unlocked) {
        setErr(t("admin.error.wrongPassphrase"))
        pushLog("unlock()", "error: wrong passphrase")
      } else {
        pushLog("unlock()", "unlocked: true")
      }
      await refetch()
      refresh()
      setPassphrase("")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      pushLog("unlock()", formatErrorResult(e))
    } finally {
      setBusy(false)
    }
  }

  async function onLock() {
    if (busy()) return
    setBusy(true)
    setErr(null)
    try {
      await window.api.admin.lock()
      pushLog("lock()", "locked")
      await refetch()
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      pushLog("lock()", formatErrorResult(e))
    } finally {
      setBusy(false)
    }
  }

  async function run(action: string, fn: () => Promise<LicenseSnapshot>) {
    if (busy()) return
    setBusy(true)
    setErr(null)
    try {
      const snapshot = await fn()
      pushLog(action, formatSnapshotResult(snapshot))
      await refetch()
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      pushLog(action, formatErrorResult(e))
    } finally {
      setBusy(false)
    }
  }

  const onRevoke = () => {
    if (!confirm(t("adminPanel.confirm.revoke"))) return
    void run("revoke()", () => window.api.admin.revoke())
  }

  const onReset = () => {
    if (!confirm(t("adminPanel.confirm.reset"))) return
    void run("reset()", () => window.api.admin.reset())
  }

  // Focus/Escape handling for the full-screen page.
  let panel: HTMLDivElement | undefined
  createEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    panel?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
      prev?.focus?.()
    })
  })

  const badgeKind = () => {
    if (isDev) return "dev"
    return status()?.unlocked ? "unlocked" : "locked"
  }

  const badgeLabel = () => {
    const k = badgeKind()
    if (k === "dev") return t("adminPanel.badge.dev")
    if (k === "unlocked") return t("adminPanel.badge.unlocked")
    return t("adminPanel.badge.locked")
  }

  return (
    <div
      data-component="admin-panel-fullscreen"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        "z-index": 100,
        background: "var(--background-base)",
        overflow: "auto",
      }}
    >
      <div data-slot="panel" ref={panel} tabindex="-1">
        <header data-slot="header">
          <div data-slot="title-row">
            <h1>{t("adminPanel.title")}</h1>
            <span data-slot="badge" data-kind={badgeKind()}>
              {badgeLabel()}
            </span>
          </div>
          <button data-slot="close" onClick={props.onClose} aria-label={t("adminPanel.close")}>
            ×
          </button>
        </header>

        <Show
          when={status()?.unlocked}
          fallback={
            <section data-slot="unlock">
              <form onSubmit={onUnlock}>
                <p>{t("adminPanel.unlockPrompt")}</p>
                <input
                  type="password"
                  placeholder={t("admin.passphrasePlaceholder")}
                  value={passphrase()}
                  onInput={(e) => setPassphrase(e.currentTarget.value)}
                  autofocus
                />
                <button type="submit" disabled={busy() || !passphrase()}>
                  {busy() ? t("admin.unlocking") : t("adminPanel.unlock")}
                </button>
              </form>
              <Show when={err()}>{(msg) => <p data-slot="error">{msg()}</p>}</Show>
            </section>
          }
        >
          <section data-slot="state">
            <h2>{t("adminPanel.state.title")}</h2>
            <dl>
              <dt>{t("admin.field.status")}</dt>
              <dd>{license()?.effectiveStatus ?? "—"}</dd>
              <dt>{t("admin.field.interval")}</dt>
              <dd>{license()?.interval ?? "—"}</dd>
              <dt>{t("admin.field.issuedBy")}</dt>
              <dd>{license()?.issuedBy ?? "—"}</dd>
              <dt>Time issued</dt>
              <dd>{formatIso(license()?.timeIssued)}</dd>
              <dt>{t("admin.field.trialEnd")}</dt>
              <dd>{formatIso(license()?.timeTrialEnd)}</dd>
              <dt>{t("admin.field.trialConsumed")}</dt>
              <dd>{formatIso(license()?.timeTrialConsumed)}</dd>
              <dt>Time expiry</dt>
              <dd>{formatIso(license()?.timeExpiry)}</dd>
              <dt>License token</dt>
              <dd>{truncateToken(license()?.licenseToken)}</dd>
            </dl>
          </section>

          <section data-slot="grant">
            <h2>{t("adminPanel.grant.title")}</h2>
            <div data-slot="buttons">
              <For each={INTERVALS}>
                {(interval) => (
                  <button
                    disabled={busy()}
                    onClick={() => run(`grant(${interval})`, () => window.api.admin.grant(interval))}
                  >
                    {t(`admin.grant.${interval}`)}
                  </button>
                )}
              </For>
            </div>
          </section>

          <section data-slot="trial-controls">
            <h2>{t("adminPanel.trial.title")}</h2>
            <button disabled={busy()} onClick={() => run("extendTrial(2)", () => window.api.admin.extendTrial(2))}>
              {t("admin.trial.extend2")}
            </button>
            <button disabled={busy()} onClick={() => run("extendTrial(7)", () => window.api.admin.extendTrial(7))}>
              {t("admin.trial.extend7")}
            </button>
          </section>

          <section data-slot="destructive">
            <h2>{t("adminPanel.destructive.title")}</h2>
            <button data-kind="warn" disabled={busy()} onClick={onRevoke}>
              {t("admin.destructive.revoke")}
            </button>
            <button data-kind="danger" disabled={busy()} onClick={onReset}>
              {t("admin.destructive.reset")}
            </button>
          </section>

          <section data-slot="log">
            <h2>{t("adminPanel.log.title")}</h2>
            <Switch
              fallback={
                <ul data-slot="log-entries">
                  <For each={log()}>
                    {(entry) => (
                      <li>
                        <span data-slot="log-time">[{entry.timestamp}]</span>{" "}
                        <span data-slot="log-action">{entry.action}</span>{" "}
                        <span data-slot="log-arrow">→</span>{" "}
                        <span data-slot="log-result">{entry.result}</span>
                      </li>
                    )}
                  </For>
                </ul>
              }
            >
              <Match when={log().length === 0}>
                <p data-slot="log-empty">{t("adminPanel.log.empty")}</p>
              </Match>
            </Switch>
          </section>

          <Show when={err()}>{(msg) => <p data-slot="error">{msg()}</p>}</Show>

          <footer data-slot="footer">
            <Show when={!isDev}>
              <button disabled={busy()} onClick={onLock}>
                {t("adminPanel.lock")}
              </button>
            </Show>
          </footer>
        </Show>
      </div>
    </div>
  )
}
