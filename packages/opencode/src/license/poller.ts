import { Log } from "../util/log"
import { captureException } from "./sentry"
import { fetchIncomingTxs } from "./payments"
import {
  confirmOrderAndIssue,
  getOffersForOrder,
  listOpenOffers,
  markOfferMatched,
} from "./store"
import { getWallets } from "./wallets"
import { sendCustomerToken } from "./telegram-notify"

const log = Log.create({ service: "license-poller" })

const POLL_INTERVAL_MS = 60_000

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
    for (const tx of txs) {
      if (tx.confirmations < wallet.minConfirmations) continue
      const expectedSet = new Map<string, (typeof openOffers)[number]>()
      for (const o of openOffers) expectedSet.set(o.expected_units, o)
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
