import { Log } from "../util/log"
import { captureException } from "./sentry"
import { fetchIncomingTxs } from "./payments"
import {
  confirmOrderAndIssue,
  getOffersForOrder,
  getOrder,
  listOpenOffers,
  markOfferMatched,
  markOfferNotifiedSeen,
  markOfferSeen,
} from "./store"
import { getWallets } from "./wallets"
import { notifyPaymentSeen, sendCustomerToken } from "./telegram-notify"

const log = Log.create({ service: "license-poller" })

// 30s is the sweet spot — 60s feels laggy when a user is staring at
// "/order" waiting for the "payment received" toast; 15s starts to
// hammer mempool.space rate limits when many offers are open.
const POLL_INTERVAL_MS = 30_000

/**
 * Coarse ETA in minutes for `remaining` blocks on `currency`. We use the
 * average inter-block time per chain — Bitcoin ≈ 10 min, Litecoin ≈ 2.5
 * min, Ethereum ≈ 12 sec. This is just for the "awaiting N confirmations
 * (~M minutes)" label in the notification; under-estimating is worse
 * than over-estimating because users will start asking "where's my
 * license?" — so we round up generously.
 */
function estimateConfirmationEta(currency: "BTC" | "LTC" | "ETH", remaining: number): number {
  if (remaining <= 0) return 0
  const avgMinutesPerBlock: Record<string, number> = {
    BTC: 10,
    LTC: 2.5,
    ETH: 0.2, // 12s/block, rounded
  }
  const perBlock = avgMinutesPerBlock[currency] ?? 5
  // +20% slack: blocks are exponentially distributed, so the expected
  // wait is variance-heavy and "average × N" is a lower bound.
  return Math.ceil(remaining * perBlock * 1.2)
}

let stopped = false
let timer: ReturnType<typeof setTimeout> | null = null

async function pollOnce(): Promise<void> {
  const wallets = getWallets()
  if (wallets.length === 0) return
  const offers = listOpenOffers(500)
  if (offers.length === 0) return

  // Group offers by (currency, wallet) so we make at most one network call per
  // wallet per cycle.
  const groups = new Map<string, typeof offers>()
  for (const o of offers) {
    const k = `${o.currency}|${o.wallet_address}`
    const list = groups.get(k) ?? []
    list.push(o)
    groups.set(k, list)
  }

  for (const [key, openOffers] of groups) {
    const [currency, address] = key.split("|") as [(typeof openOffers)[number]["currency"], string]
    const wallet = wallets.find((w) => w.currency === currency && w.address === address)
    if (!wallet) continue
    let txs
    try {
      txs = await fetchIncomingTxs(currency, address)
    } catch (err) {
      log.warn("fetchIncomingTxs failed", { currency, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    // Index offers by expected amount once per group so both the
    // in-progress (seen but not enough confirmations) and the
    // confirmed branches share the same lookup.
    const expectedSet = new Map<string, (typeof openOffers)[number]>()
    for (const o of openOffers) expectedSet.set(o.expected_units, o)

    for (const tx of txs) {
      const seenMatch = expectedSet.get(tx.amountUnits.toString())

      // Branch 1: tx with confirmations < minConfirmations — record + notify
      // ONCE per offer, then skip (the next poll cycle will re-evaluate
      // and either move it to issued state or update the conf count).
      if (seenMatch && tx.confirmations < wallet.minConfirmations) {
        markOfferSeen({
          id: seenMatch.id,
          txHash: tx.txid,
          confirmations: tx.confirmations,
        })
        // First-time sighting → fire the "payment received, awaiting
        // confirmations" notification so the user isn't left in the dark.
        const isFirstSighting = markOfferNotifiedSeen(seenMatch.id)
        if (isFirstSighting) {
          const order = getOrder(seenMatch.order_id)
          if (order?.customer_user_id) {
            await notifyPaymentSeen({
              telegram_user_id: order.customer_user_id,
              order_id: order.id,
              currency: seenMatch.currency,
              tx: tx.txid,
              current_confirmations: tx.confirmations,
              required_confirmations: wallet.minConfirmations,
              eta_minutes: estimateConfirmationEta(seenMatch.currency, wallet.minConfirmations - tx.confirmations),
            }).catch((err) =>
              log.warn("notifyPaymentSeen failed", { error: err instanceof Error ? err.message : String(err) }),
            )
            log.info("payment seen, awaiting confirmations", {
              offer_id: seenMatch.id,
              order_id: order.id,
              tx: tx.txid,
              conf: `${tx.confirmations}/${wallet.minConfirmations}`,
            })
          }
        }
        continue
      }

      // Branch 2: confirmations met — proceed to issuance.
      if (tx.confirmations < wallet.minConfirmations) continue
      const match = expectedSet.get(tx.amountUnits.toString())
      if (!match) continue
      // Atomic-ish: mark offer matched. The DB unique constraint via matched_tx_hash
      // partial index plus the `matched_tx_hash IS NULL` clause means a duplicate
      // poller cycle cannot double-issue.
      markOfferMatched(match.id, tx.txid)
      const issued = confirmOrderAndIssue({ order_id: match.order_id, tx_hash: tx.txid })
      if ("error" in issued) {
        log.warn("confirmOrderAndIssue failed after match", { offer_id: match.id, error: issued.error })
        continue
      }
      log.info("payment matched + license issued", {
        order_id: issued.order.id,
        license_id: issued.license.id,
        currency,
        tx: tx.txid,
      })
      // Cancel sibling offers (other currencies) — order is already paid.
      for (const sibling of getOffersForOrder(match.order_id)) {
        if (sibling.id !== match.id && !sibling.matched_tx_hash) {
          markOfferMatched(sibling.id, "_superseded_by_" + match.id)
        }
      }
      // Notify customer in Telegram.
      if (issued.customer.telegram_user_id) {
        await sendCustomerToken({
          telegram_user_id: issued.customer.telegram_user_id,
          license_id: issued.license.id,
          interval: issued.license.interval,
          expires_at: issued.license.expires_at,
          token: issued.token,
          currency,
          tx: tx.txid,
        }).catch((err) =>
          log.warn("notify failed", { error: err instanceof Error ? err.message : String(err) }),
        )
      }
    }
  }
}

export function startPaymentPoller(): void {
  if (timer) return
  if (getWallets().length === 0) {
    log.info("no wallet env vars set — payment poller disabled")
    return
  }
  log.info("starting payment poller", { wallets: getWallets().map((w) => w.currency) })
  const tick = async () => {
    if (stopped) return
    try {
      await pollOnce()
    } catch (err) {
      log.warn("pollOnce error", { error: err instanceof Error ? err.message : String(err) })
      captureException(err, { tags: { surface: "payment-poller" } })
    }
    timer = setTimeout(tick, POLL_INTERVAL_MS)
  }
  timer = setTimeout(tick, 5_000) // first tick after 5s warmup
}

export function stopPaymentPoller(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
