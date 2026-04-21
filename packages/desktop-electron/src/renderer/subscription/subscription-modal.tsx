import { For, Show, Switch, Match, createSignal, createEffect, onCleanup } from "solid-js"
import { t } from "../i18n"
import { useLicense } from "./use-license"
import type { ProInterval } from "../../preload/types"

const INTERVALS: ReadonlyArray<{
  id: ProInterval
  labelKey: Parameters<typeof t>[0]
  noTrial?: boolean
}> = [
  { id: "monthly", labelKey: "subscription.interval.monthly" },
  { id: "annual", labelKey: "subscription.interval.annual" },
  { id: "lifetime", labelKey: "subscription.interval.lifetime", noTrial: true },
]

export function SubscriptionModal(props: { open: boolean; onClose: () => void }) {
  const { license, refresh } = useLicense()
  const [busy, setBusy] = createSignal<ProInterval | "trial" | null>(null)
  const [err, setErr] = createSignal<string | null>(null)

  async function onTrial() {
    if (busy()) return
    setBusy("trial")
    setErr(null)
    try {
      await window.api.license.startTrial()
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onSubscribe(interval: ProInterval) {
    if (busy()) return
    setBusy(interval)
    setErr(null)
    try {
      await window.api.license.openCheckout(interval)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  let panel: HTMLDivElement | undefined
  createEffect(() => {
    if (!props.open) return
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

  return (
    <Show when={props.open}>
      <div data-component="subscription-modal" role="dialog" aria-modal="true">
        <div data-slot="backdrop" onClick={props.onClose} />
        <div data-slot="panel" ref={panel} tabindex="-1">
          <header>
            <h2>{t("subscription.title")}</h2>
            <button data-slot="close" onClick={props.onClose} aria-label={t("subscription.close")}>
              ×
            </button>
          </header>
          <section data-slot="status">
            <Switch fallback={<p>{t("subscription.status.loading")}</p>}>
              <Match when={license()?.effectiveStatus === "active"}>
                <p>{t("subscription.status.active", { interval: license()?.interval ?? "" })}</p>
              </Match>
              <Match when={license()?.effectiveStatus === "trial"}>
                <p>
                  {t("subscription.status.trial", {
                    days: String(license()?.trialDaysRemaining ?? 0),
                  })}
                </p>
              </Match>
              <Match when={license()?.effectiveStatus === "trial_expired"}>
                <p>{t("subscription.status.trialExpired")}</p>
              </Match>
              <Match when={license()?.effectiveStatus === "expired"}>
                <p>{t("subscription.status.expired")}</p>
              </Match>
              <Match when={license()?.effectiveStatus === "free"}>
                <p>{t("subscription.status.free")}</p>
              </Match>
              <Match when={license()?.effectiveStatus === "revoked"}>
                <p>{t("subscription.status.revoked")}</p>
              </Match>
            </Switch>
          </section>

          <section data-slot="plans">
            <For each={INTERVALS}>
              {(opt) => (
                <button
                  data-interval={opt.id}
                  disabled={!!busy() || license()?.effectiveStatus === "active"}
                  onClick={() => onSubscribe(opt.id)}
                >
                  <span data-slot="label">{t(opt.labelKey)}</span>
                  <Show when={!opt.noTrial}>
                    <span data-slot="badge">{t("subscription.trialBadge")}</span>
                  </Show>
                </button>
              )}
            </For>
          </section>

          <Show when={license()?.effectiveStatus === "free" && !license()?.timeTrialConsumed}>
            <section data-slot="trial-cta">
              <button disabled={busy() === "trial"} onClick={onTrial}>
                {busy() === "trial" ? t("subscription.trialStarting") : t("subscription.startTrial")}
              </button>
            </section>
          </Show>

          <Show when={err()}>{(msg) => <p data-slot="error">{msg()}</p>}</Show>
        </div>
      </div>
    </Show>
  )
}
