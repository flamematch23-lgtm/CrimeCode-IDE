import { For, Match, Show, Switch, createSignal, type JSX } from "solid-js"
import { t } from "../i18n"
import { hasProAccess, useLicense } from "./use-license"
import type { ProInterval } from "../../preload/types"

type PlanOption = {
  id: ProInterval
  titleKey: Parameters<typeof t>[0]
  priceKey: Parameters<typeof t>[0]
  badgeKey?: Parameters<typeof t>[0]
}

const PLANS: ReadonlyArray<PlanOption> = [
  {
    id: "monthly",
    titleKey: "gate.plan.monthly.title",
    priceKey: "gate.plan.monthly.price",
  },
  {
    id: "annual",
    titleKey: "gate.plan.annual.title",
    priceKey: "gate.plan.annual.price",
    badgeKey: "gate.plan.annual.badge",
  },
  {
    id: "lifetime",
    titleKey: "gate.plan.lifetime.title",
    priceKey: "gate.plan.lifetime.price",
    badgeKey: "gate.plan.lifetime.badge",
  },
]

export function SubscriptionGate(props: { children: JSX.Element }): JSX.Element {
  const { license, refresh } = useLicense()
  const [busy, setBusy] = createSignal<ProInterval | "trial" | "token" | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [showTokenForm, setShowTokenForm] = createSignal(false)
  const [tokenValue, setTokenValue] = createSignal("")
  const [tokenInterval, setTokenInterval] = createSignal<ProInterval>("monthly")

  async function onSubscribe(interval: ProInterval, contact: "opcrime" | "jollyfraud") {
    if (busy()) return
    setBusy(interval)
    setErr(null)
    try {
      await window.api.license.openCheckout({ interval, contact })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onStartTrial() {
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

  async function onActivateToken(e: Event) {
    e.preventDefault()
    if (busy()) return
    const token = tokenValue().trim()
    if (!token) return
    setBusy("token")
    setErr(null)
    try {
      await window.api.license.activateToken({ interval: tokenInterval(), token })
      await refresh()
      setShowTokenForm(false)
      setTokenValue("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Switch
      fallback={
        <div data-component="subscription-gate-loading" role="status" aria-live="polite">
          <div data-slot="spinner" />
        </div>
      }
    >
      <Match when={hasProAccess(license())}>{props.children}</Match>
      <Match
        when={(() => {
          const status = license()?.effectiveStatus
          return (
            status === "free" || status === "trial_expired" || status === "expired" || status === "revoked"
          )
        })()}
      >
        <div data-component="subscription-gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
          <div data-slot="panel">
            <header>
              <div data-slot="logo" aria-hidden="true">CrimeCode</div>
              <h1 id="gate-title">{t("gate.title")}</h1>
              <p data-slot="subtitle">
                <Switch>
                  <Match when={license()?.effectiveStatus === "free"}>{t("gate.status.free")}</Match>
                  <Match when={license()?.effectiveStatus === "trial_expired"}>
                    {t("gate.status.trialExpired")}
                  </Match>
                  <Match when={license()?.effectiveStatus === "expired"}>{t("gate.status.expired")}</Match>
                  <Match when={license()?.effectiveStatus === "revoked"}>{t("gate.status.revoked")}</Match>
                </Switch>
              </p>
            </header>

            <section data-slot="plans">
              <For each={PLANS}>
                {(plan) => (
                  <div data-slot="plan-card" data-interval={plan.id}>
                    <div data-slot="plan-header">
                      <span data-slot="plan-title">{t(plan.titleKey)}</span>
                      <span data-slot="plan-price">{t(plan.priceKey)}</span>
                      <Show when={plan.badgeKey}>
                        {(key) => <span data-slot="plan-badge">{t(key())}</span>}
                      </Show>
                    </div>
                    <div data-slot="contact-picker">
                      <span data-slot="contact-label">{t("checkout.contact.subtitle")}</span>
                      <button
                        data-contact="opcrime"
                        disabled={!!busy()}
                        onClick={() => onSubscribe(plan.id, "opcrime")}
                      >
                        {t("checkout.contact.opcrime")}
                      </button>
                      <button
                        data-contact="jollyfraud"
                        disabled={!!busy()}
                        onClick={() => onSubscribe(plan.id, "jollyfraud")}
                      >
                        {t("checkout.contact.jollyfraud")}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </section>

            <Show when={license()?.effectiveStatus === "free"}>
              <section data-slot="trial-cta">
                <Show
                  when={license()?.timeTrialConsumed === null}
                  fallback={<p data-slot="trial-consumed">{t("gate.startTrial.consumed")}</p>}
                >
                  <button data-kind="primary" disabled={!!busy()} onClick={onStartTrial}>
                    {t("gate.startTrial")}
                  </button>
                </Show>
              </section>
            </Show>

            <section data-slot="token">
              <Show
                when={showTokenForm()}
                fallback={
                  <button data-kind="ghost" onClick={() => setShowTokenForm(true)}>
                    {t("gate.haveToken")}
                  </button>
                }
              >
                <form onSubmit={onActivateToken}>
                  <select
                    value={tokenInterval()}
                    onChange={(e) => setTokenInterval(e.currentTarget.value as ProInterval)}
                  >
                    <For each={PLANS}>
                      {(plan) => <option value={plan.id}>{t(plan.titleKey)}</option>}
                    </For>
                  </select>
                  <input
                    type="text"
                    placeholder={t("gate.tokenPlaceholder")}
                    value={tokenValue()}
                    onInput={(e) => setTokenValue(e.currentTarget.value)}
                  />
                  <button type="submit" disabled={!!busy() || !tokenValue().trim()}>
                    {t("gate.tokenSubmit")}
                  </button>
                </form>
              </Show>
            </section>

            <Show when={err()}>{(msg) => <p data-slot="error">{msg()}</p>}</Show>

            <footer data-slot="footer">
              <p>{t("gate.paymentInfo")}</p>
              <div data-slot="telegram-links">
                <a href="https://t.me/OpCrime1312" target="_blank" rel="noopener noreferrer">
                  {t("gate.telegramPrimary")}
                </a>
                <a href="https://t.me/JollyFraud" target="_blank" rel="noopener noreferrer">
                  {t("gate.telegramSecondary")}
                </a>
              </div>
            </footer>
          </div>
        </div>
      </Match>
    </Switch>
  )
}
