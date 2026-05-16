import { For, Match, Show, Switch, createSignal, type JSX } from "solid-js"
import { t } from "../i18n"
import { hasProAccess, useLicense } from "./use-license"
import type { ProInterval } from "../../preload/types"

const BOT_URL = "https://t.me/CrimeCodeSub_bot"

type PlanOption = {
  id: ProInterval
  emoji: string
  titleKey: Parameters<typeof t>[0]
  priceKey: Parameters<typeof t>[0]
  descKey: Parameters<typeof t>[0]
  badgeKey?: Parameters<typeof t>[0]
}

const PLANS: ReadonlyArray<PlanOption> = [
  {
    id: "monthly",
    emoji: "⚡",
    titleKey: "gate.plan.monthly.title",
    priceKey: "gate.plan.monthly.price",
    descKey: "gate.plan.monthly.desc",
  },
  {
    id: "annual",
    emoji: "🔥",
    titleKey: "gate.plan.annual.title",
    priceKey: "gate.plan.annual.price",
    descKey: "gate.plan.annual.desc",
    badgeKey: "gate.plan.annual.badge",
  },
  {
    id: "lifetime",
    emoji: "💎",
    titleKey: "gate.plan.lifetime.title",
    priceKey: "gate.plan.lifetime.price",
    descKey: "gate.plan.lifetime.desc",
    badgeKey: "gate.plan.lifetime.badge",
  },
]

const FEATURE_KEYS: ReadonlyArray<Parameters<typeof t>[0]> = [
  "gate.feature.1",
  "gate.feature.2",
  "gate.feature.3",
  "gate.feature.4",
]

export function SubscriptionGate(props: { children: JSX.Element }): JSX.Element {
  const { license, refresh } = useLicense()
  const [busy, setBusy] = createSignal<ProInterval | "trial" | "token" | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [showTokenForm, setShowTokenForm] = createSignal(false)
  const [tokenValue, setTokenValue] = createSignal("")
  const [tokenInterval, setTokenInterval] = createSignal<ProInterval>("monthly")

  function openBot(interval: ProInterval) {
    if (busy()) return
    setBusy(interval)
    setErr(null)
    try {
      // Telegram deep-link: t.me/Bot?start=<payload>. The bot recognises the
      // interval prefix and creates the order automatically.
      const url = `${BOT_URL}?start=order_${interval}`
      window.api.openLink(url)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Alternative checkout via Crypoverse hosted gateway. The user is always
   * signed-in by the time we render the gate (auth-gate sits above us), so
   * we have a telegram_user_id ready to attach to the order. We POST the
   * order to our backend, get back a redirect URL, and open it in the
   * system browser — the user picks crypto + completes payment on
   * crypoverse.com, and the Telegram bot DMs the license token back as
   * soon as the SSE listener fires.
   */
  async function payWithCrypoverse(interval: ProInterval) {
    if (busy()) return
    setBusy(interval)
    setErr(null)
    try {
      const session = await window.api.account.get()
      if (!session?.telegram_user_id && !session?.token) {
        setErr("Please sign in first (Account → Sign in with Telegram).")
        return
      }
      // Fall back to the marketing-site checkout if for some reason we
      // don't have a telegram_user_id on this account row — the site's
      // modal will ask for the handle explicitly.
      if (!session.telegram_user_id) {
        window.api.openLink(`https://crimecode.cc/pricing#${interval}`)
        return
      }
      const resp = await fetch("https://api.crimecode.cc/license/orders/crypoverse", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify({ interval, telegram_user_id: session.telegram_user_id }),
      })
      const data = (await resp.json().catch(() => ({}))) as {
        redirect_url?: string
        error?: string
        details?: string
      }
      if (!resp.ok || !data.redirect_url) {
        throw new Error(data.error || data.details || `HTTP ${resp.status}`)
      }
      window.api.openLink(data.redirect_url)
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
          return status === "free" || status === "trial_expired" || status === "expired" || status === "revoked"
        })()}
      >
        <div data-component="subscription-gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
          <div data-slot="bg-grid" aria-hidden="true" />
          <div data-slot="bg-glow" aria-hidden="true" />

          <div data-slot="panel">
            <header>
              <div data-slot="brand-row" aria-hidden="true">
                <div data-slot="brand-tile">CC</div>
                <div data-slot="logo" data-text="CRIMECODE">
                  CRIMECODE
                </div>
              </div>
              <h1 id="gate-title">
                <span data-slot="h1-pre">Unlock</span> <span data-slot="h1-emph">CrimeCode Pro</span>
              </h1>
              <p data-slot="tagline">{t("gate.tagline")}</p>
              <p data-slot="subtitle">
                <Switch>
                  <Match when={license()?.effectiveStatus === "free"}>{t("gate.status.free")}</Match>
                  <Match when={license()?.effectiveStatus === "trial_expired"}>{t("gate.status.trialExpired")}</Match>
                  <Match when={license()?.effectiveStatus === "expired"}>{t("gate.status.expired")}</Match>
                  <Match when={license()?.effectiveStatus === "revoked"}>{t("gate.status.revoked")}</Match>
                </Switch>
              </p>
            </header>

            <section data-slot="features">
              <h2>{t("gate.featureList.title")}</h2>
              <ul>
                <For each={FEATURE_KEYS}>{(k) => <li>{t(k)}</li>}</For>
              </ul>
            </section>

            <section data-slot="plans">
              <For each={PLANS}>
                {(plan) => (
                  <div data-slot="plan-card" data-interval={plan.id}>
                    <Show when={plan.badgeKey}>{(key) => <span data-slot="plan-badge">{t(key())}</span>}</Show>
                    <div data-slot="plan-emoji" aria-hidden="true">
                      {plan.emoji}
                    </div>
                    <div data-slot="plan-title">{t(plan.titleKey)}</div>
                    <div data-slot="plan-price">{t(plan.priceKey)}</div>
                    <div data-slot="plan-desc">{t(plan.descKey)}</div>
                    <p data-slot="plan-note">{t("gate.payNote")}</p>
                    <button
                      data-slot="pay-btn"
                      data-interval={plan.id}
                      disabled={!!busy()}
                      onClick={() => openBot(plan.id)}
                    >
                      <span data-slot="btn-label">{t("gate.payButton")}</span>
                      <span data-slot="btn-arrow" aria-hidden="true">
                        →
                      </span>
                    </button>
                    <button
                      data-slot="pay-btn-alt"
                      data-interval={plan.id}
                      data-kind="crypoverse"
                      disabled={!!busy()}
                      onClick={() => payWithCrypoverse(plan.id)}
                      title="Pay via Crypoverse hosted gateway (any crypto, USD conversion done for you)"
                    >
                      <span data-slot="btn-label">{t("gate.payCryptoverseButton")}</span>
                      <span data-slot="btn-arrow" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </div>
                )}
              </For>
            </section>

            <p data-slot="payment-info">{t("gate.paymentInfo")}</p>

            <Show when={license()?.effectiveStatus === "free"}>
              <section data-slot="trial-cta">
                <Show
                  when={license()?.timeTrialConsumed === null}
                  fallback={<p data-slot="trial-consumed">{t("gate.startTrial.consumed")}</p>}
                >
                  <button data-kind="primary" disabled={!!busy()} onClick={onStartTrial}>
                    🎁 {t("gate.startTrial")}
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
                <form onSubmit={onActivateToken} aria-label="Activate license token">
                  <label class="sr-only" for="gate-token-interval">
                    Plan
                  </label>
                  <select
                    id="gate-token-interval"
                    value={tokenInterval()}
                    onChange={(e) => setTokenInterval(e.currentTarget.value as ProInterval)}
                    aria-label="Plan"
                  >
                    <For each={PLANS}>{(plan) => <option value={plan.id}>{t(plan.titleKey)}</option>}</For>
                  </select>
                  <label class="sr-only" for="gate-token-input">
                    License token
                  </label>
                  <input
                    id="gate-token-input"
                    type="text"
                    placeholder={t("gate.tokenPlaceholder")}
                    value={tokenValue()}
                    onInput={(e) => setTokenValue(e.currentTarget.value)}
                    aria-label="License token"
                  />
                  <button type="submit" disabled={!!busy() || !tokenValue().trim()}>
                    {t("gate.tokenSubmit")}
                  </button>
                </form>
              </Show>
            </section>

            <Show when={err()}>{(msg) => <p data-slot="error">⚠️ {msg()}</p>}</Show>

            <footer data-slot="footer">
              <div data-slot="telegram-links">
                <a href="https://t.me/OpCrime1312" target="_blank" rel="noopener noreferrer">
                  💬 {t("gate.telegramPrimary")}
                </a>
                <a href="https://t.me/JollyFraud" target="_blank" rel="noopener noreferrer">
                  💬 {t("gate.telegramSecondary")}
                </a>
              </div>
            </footer>
          </div>
        </div>
      </Match>
    </Switch>
  )
}
