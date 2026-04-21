import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { t } from "../i18n"
import { useLicense } from "./use-license"
import type { ProInterval } from "../../preload/types"

const INTERVALS: ProInterval[] = ["monthly", "annual", "lifetime"]

export function AdminModal(props: { open: boolean; onClose: () => void }) {
  const { license, refresh } = useLicense()
  const [status, { refetch }] = createResource(
    () => props.open,
    () => window.api.admin.status(),
  )
  const [passphrase, setPassphrase] = createSignal("")
  const [err, setErr] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  async function onUnlock() {
    if (busy()) return
    setBusy(true)
    setErr(null)
    try {
      const result = await window.api.admin.unlock(passphrase())
      if (!result.unlocked) setErr(t("admin.error.wrongPassphrase"))
      await refetch()
      refresh()
      setPassphrase("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function run<T>(fn: () => Promise<T>) {
    if (busy()) return
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await refetch()
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
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
      await refetch()
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  let panel: HTMLDivElement | undefined
  createEffect(() => {
    if (!props.open) return
    setErr(null)
    const prev = document.activeElement as HTMLElement | null
    panel?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
      prev?.focus()
    })
  })

  return (
    <Show when={props.open}>
      <div data-component="admin-modal" role="dialog" aria-modal="true">
        <div data-slot="backdrop" onClick={props.onClose} />
        <div data-slot="panel" ref={panel} tabindex="-1">
          <header>
            <h2>{t("admin.title")}</h2>
            <button data-slot="close" onClick={props.onClose}>
              ×
            </button>
          </header>

          <Show
            when={status()?.unlocked}
            fallback={
              <section data-slot="unlock">
                <p>{t("admin.unlockPrompt")}</p>
                <input
                  type="password"
                  placeholder={t("admin.passphrasePlaceholder")}
                  value={passphrase()}
                  onInput={(e) => setPassphrase(e.currentTarget.value)}
                />
                <button disabled={busy() || !passphrase()} onClick={onUnlock}>
                  {busy() ? t("admin.unlocking") : t("admin.unlock")}
                </button>
              </section>
            }
          >
            <section data-slot="state">
              <dl>
                <dt>{t("admin.field.status")}</dt>
                <dd>{license()?.effectiveStatus ?? "—"}</dd>
                <dt>{t("admin.field.interval")}</dt>
                <dd>{license()?.interval ?? "—"}</dd>
                <dt>{t("admin.field.issuedBy")}</dt>
                <dd>{license()?.issuedBy ?? "—"}</dd>
                <dt>{t("admin.field.trialEnd")}</dt>
                <dd>{license()?.timeTrialEnd ?? "—"}</dd>
                <dt>{t("admin.field.trialConsumed")}</dt>
                <dd>{license()?.timeTrialConsumed ?? "—"}</dd>
              </dl>
            </section>

            <section data-slot="grant">
              <h3>{t("admin.grant.title")}</h3>
              <div data-slot="buttons">
                <For each={INTERVALS}>
                  {(interval) => (
                    <button disabled={busy()} onClick={() => run(() => window.api.admin.grant(interval))}>
                      {t(`admin.grant.${interval}`)}
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section data-slot="trial-controls">
              <h3>{t("admin.trial.title")}</h3>
              <button disabled={busy()} onClick={() => run(() => window.api.admin.extendTrial(2))}>
                {t("admin.trial.extend2")}
              </button>
              <button disabled={busy()} onClick={() => run(() => window.api.admin.extendTrial(7))}>
                {t("admin.trial.extend7")}
              </button>
            </section>

            <section data-slot="destructive">
              <h3>{t("admin.destructive.title")}</h3>
              <button data-kind="warn" disabled={busy()} onClick={() => run(() => window.api.admin.revoke())}>
                {t("admin.destructive.revoke")}
              </button>
              <button
                data-kind="danger"
                disabled={busy()}
                onClick={() => {
                  if (confirm(t("admin.destructive.resetConfirm"))) {
                    run(() => window.api.admin.reset())
                  }
                }}
              >
                {t("admin.destructive.reset")}
              </button>
            </section>

            <footer>
              <button disabled={busy()} onClick={onLock}>
                {t("admin.lock")}
              </button>
            </footer>
          </Show>

          <Show when={err()}>{(msg) => <p data-slot="error">{msg()}</p>}</Show>
        </div>
      </div>
    </Show>
  )
}
