/**
 * Admin-only helpers for the /admin#payments dashboard section.
 *
 * Provides three views the operator wants on one page:
 *   1. Wallets — every configured on-chain wallet (BTC/LTC/ETH) with
 *      live balance + recent inbound txs + ready-to-share QR.
 *   2. Settlements — unified history of every confirmed payment, both
 *      on-chain (payment_offers join orders) and Crypoverse-gateway
 *      (crypoverse_invoices join orders), sorted by paid time.
 *   3. Config — runtime status of every payment subsystem: which
 *      providers are enabled, listener counts, plan prices.
 *
 * Balance fetches are cached in-process for 60s so refreshing the
 * dashboard doesn't hammer mempool.space / litecoinspace / etherscan
 * with one HTTP call per visit.
 */
import { Log } from "../util/log"
import { getDb } from "./db"
import { getWallets, type WalletConfig } from "./wallets"
import { paymentUri, qrCodeUrl } from "./payments"
import { getUsdRate } from "./prices"
import { getListenerCount } from "./crypoverse"

const log = Log.create({ service: "admin-payments" })

// ── Wallet balance fetcher (cached) ───────────────────────────────────

interface WalletBalance {
  currency: WalletConfig["currency"]
  address: string
  confirmed_units: bigint
  unconfirmed_units: bigint
  tx_count: number
  error?: string
  fetched_at: number
}

const BALANCE_CACHE_TTL_MS = 60_000
const balanceCache = new Map<string, WalletBalance>()

async function jsonFetch<T>(url: string, timeoutMs = 8_000): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface EsploraAddr {
  chain_stats?: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number }
  mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number }
}

async function fetchEsploraBalance(currency: "BTC" | "LTC", address: string): Promise<WalletBalance> {
  const host = currency === "BTC" ? "https://mempool.space/api" : "https://litecoinspace.org/api"
  const data = await jsonFetch<EsploraAddr>(`${host}/address/${address}`)
  const fetched_at = Math.floor(Date.now() / 1000)
  if (!data) {
    return {
      currency,
      address,
      confirmed_units: 0n,
      unconfirmed_units: 0n,
      tx_count: 0,
      error: "explorer_unreachable",
      fetched_at,
    }
  }
  const conf = (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0)
  const memp = (data.mempool_stats?.funded_txo_sum ?? 0) - (data.mempool_stats?.spent_txo_sum ?? 0)
  return {
    currency,
    address,
    confirmed_units: BigInt(Math.max(0, conf)),
    unconfirmed_units: BigInt(Math.max(0, memp)),
    tx_count: (data.chain_stats?.tx_count ?? 0) + (data.mempool_stats?.tx_count ?? 0),
    fetched_at,
  }
}

async function fetchEthBalance(address: string): Promise<WalletBalance> {
  const fetched_at = Math.floor(Date.now() / 1000)
  // Prefer Etherscan if a key is configured (higher rate limits), else
  // fall back to Blockcypher's free tier — same fallback strategy used
  // by the existing on-chain payment poller.
  const esKey = process.env.ETHERSCAN_API_KEY
  if (esKey) {
    type Res = { status: string; message: string; result: string }
    const data = await jsonFetch<Res>(
      `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${esKey}`,
    )
    if (!data || data.status !== "1") {
      return { currency: "ETH", address, confirmed_units: 0n, unconfirmed_units: 0n, tx_count: 0, error: "etherscan_unreachable", fetched_at }
    }
    return {
      currency: "ETH",
      address,
      confirmed_units: BigInt(data.result || "0"),
      unconfirmed_units: 0n,
      tx_count: 0,
      fetched_at,
    }
  }
  type BcRes = { balance: number; unconfirmed_balance: number; n_tx: number; unconfirmed_n_tx: number }
  const data = await jsonFetch<BcRes>(`https://api.blockcypher.com/v1/eth/main/addrs/${address.replace(/^0x/, "")}/balance`)
  if (!data) {
    return { currency: "ETH", address, confirmed_units: 0n, unconfirmed_units: 0n, tx_count: 0, error: "blockcypher_unreachable", fetched_at }
  }
  // Blockcypher returns gwei (10^-9 ETH); convert to wei (10^-18 ETH).
  return {
    currency: "ETH",
    address,
    confirmed_units: BigInt(data.balance ?? 0) * 10n ** 9n,
    unconfirmed_units: BigInt(data.unconfirmed_balance ?? 0) * 10n ** 9n,
    tx_count: (data.n_tx ?? 0) + (data.unconfirmed_n_tx ?? 0),
    fetched_at,
  }
}

async function fetchBalance(w: WalletConfig): Promise<WalletBalance> {
  const cacheKey = `${w.currency}:${w.address}`
  const cached = balanceCache.get(cacheKey)
  if (cached && Date.now() - cached.fetched_at * 1000 < BALANCE_CACHE_TTL_MS) {
    return cached
  }
  let fresh: WalletBalance
  try {
    fresh = w.currency === "ETH" ? await fetchEthBalance(w.address) : await fetchEsploraBalance(w.currency, w.address)
  } catch (err) {
    log.warn("balance fetch crashed", { currency: w.currency, error: err instanceof Error ? err.message : String(err) })
    fresh = {
      currency: w.currency,
      address: w.address,
      confirmed_units: 0n,
      unconfirmed_units: 0n,
      tx_count: 0,
      error: err instanceof Error ? err.message : String(err),
      fetched_at: Math.floor(Date.now() / 1000),
    }
  }
  balanceCache.set(cacheKey, fresh)
  return fresh
}

const DECIMALS_BY_CURRENCY: Record<WalletConfig["currency"], number> = {
  BTC: 8,
  LTC: 8,
  ETH: 18,
}

function formatUnits(units: bigint, currency: WalletConfig["currency"]): string {
  const dec = DECIMALS_BY_CURRENCY[currency]
  const factor = 10n ** BigInt(dec)
  const whole = units / factor
  const frac = units % factor
  const fracStr = frac.toString().padStart(dec, "0").replace(/0+$/, "")
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}

/**
 * Return every configured wallet with live balance, USD-equivalent
 * value, and a ready-to-show QR code URL for receiving payments.
 */
export async function getWalletsWithBalance(): Promise<Array<{
  currency: WalletConfig["currency"]
  address: string
  min_confirmations: number
  confirmed_units: string
  unconfirmed_units: string
  tx_count: number
  balance_formatted: string
  usd_value: number | null
  qr_url: string
  pay_uri: string
  error: string | null
  fetched_at: number
}>> {
  const wallets = getWallets()
  const out = await Promise.all(
    wallets.map(async (w) => {
      const bal = await fetchBalance(w)
      const total_units = bal.confirmed_units + bal.unconfirmed_units
      const balance_formatted = formatUnits(bal.confirmed_units, w.currency)
      const rate = await getUsdRate(w.currency).catch(() => null)
      const usd_value =
        rate != null && total_units > 0n
          ? Math.round(Number(formatUnits(total_units, w.currency)) * rate * 100) / 100
          : null
      // BIP-21 URI without a fixed amount — operator can use this as a
      // generic "Pay me here" QR when invoicing offline.
      const pay_uri = paymentUri(w.currency, w.address, 0n).replace(/\?amount=0$/, "")
      return {
        currency: w.currency,
        address: w.address,
        min_confirmations: w.minConfirmations,
        confirmed_units: bal.confirmed_units.toString(),
        unconfirmed_units: bal.unconfirmed_units.toString(),
        tx_count: bal.tx_count,
        balance_formatted,
        usd_value,
        qr_url: qrCodeUrl(pay_uri, 220),
        pay_uri,
        error: bal.error ?? null,
        fetched_at: bal.fetched_at,
      }
    }),
  )
  return out
}

// ── Settlement history ────────────────────────────────────────────────
// Unified ledger across the two payment rails. Each row represents one
// completed transaction (license sold + paid). Sorted by paid_at desc.

interface SettlementRow {
  ts: number // unix sec (paid_at)
  source: "onchain" | "crypoverse"
  order_id: string
  customer_telegram: string | null
  interval: string
  amount_usd: number
  currency: string
  tx_hash: string | null
  license_id: string | null
}

export function getSettlementHistory(limit = 100): SettlementRow[] {
  const db = getDb()
  const lim = Math.max(1, Math.min(500, limit))
  const priceByInterval: Record<string, number> = { monthly: 20, annual: 200, lifetime: 500 }
  // On-chain settlements: join orders + payment_offers on matched tx.
  // We use match.matched_at as the canonical paid time (confirmations met).
  const onchain = db
    .prepare<
      {
        ts: number
        order_id: string
        customer_telegram: string | null
        interval: string
        currency: string
        tx_hash: string | null
        license_id: string | null
      },
      [number]
    >(
      `SELECT po.matched_at AS ts,
              o.id          AS order_id,
              o.customer_telegram,
              o.interval,
              po.currency,
              po.matched_tx_hash AS tx_hash,
              o.license_id
       FROM payment_offers po
       JOIN orders o ON o.id = po.order_id
       WHERE po.matched_tx_hash IS NOT NULL
         AND po.matched_tx_hash NOT LIKE '_superseded_by_%'
         AND po.matched_at IS NOT NULL
       ORDER BY po.matched_at DESC
       LIMIT ?`,
    )
    .all(lim)
    .map<SettlementRow>((r) => ({
      ts: r.ts,
      source: "onchain",
      order_id: r.order_id,
      customer_telegram: r.customer_telegram,
      interval: r.interval,
      amount_usd: priceByInterval[r.interval] ?? 0,
      currency: r.currency,
      tx_hash: r.tx_hash,
      license_id: r.license_id,
    }))

  // Crypoverse settlements: invoice with paid_at set.
  const crypo = db
    .prepare<
      {
        ts: number
        order_id: string
        customer_telegram: string | null
        interval: string
        amount_usd: number
        tx_hash: string | null
        license_id: string | null
      },
      [number]
    >(
      `SELECT i.paid_at AS ts,
              i.order_id,
              o.customer_telegram,
              o.interval,
              i.amount_usd,
              i.paid_tx_hash AS tx_hash,
              o.license_id
       FROM crypoverse_invoices i
       JOIN orders o ON o.id = i.order_id
       WHERE i.paid_at IS NOT NULL
       ORDER BY i.paid_at DESC
       LIMIT ?`,
    )
    .all(lim)
    .map<SettlementRow>((r) => ({
      ts: r.ts,
      source: "crypoverse",
      order_id: r.order_id,
      customer_telegram: r.customer_telegram,
      interval: r.interval,
      amount_usd: r.amount_usd,
      currency: "USD",
      tx_hash: r.tx_hash,
      license_id: r.license_id,
    }))

  // Merge + sort desc by paid time + truncate to lim.
  return [...onchain, ...crypo].sort((a, b) => b.ts - a.ts).slice(0, lim)
}

// ── Payment config snapshot ──────────────────────────────────────────

export function getPaymentConfig(): {
  providers: {
    onchain_enabled: boolean
    onchain_wallets_configured: number
    crypoverse_enabled: boolean
    crypoverse_listeners_active: number
  }
  plan_prices_usd: { monthly: number; annual: number; lifetime: number }
  poller_interval_seconds: number
  env: {
    btc_wallet_set: boolean
    ltc_wallet_set: boolean
    eth_wallet_set: boolean
    etherscan_api_key: boolean
    crypoverse_api_key: boolean
  }
} {
  const wallets = getWallets()
  return {
    providers: {
      onchain_enabled: wallets.length > 0,
      onchain_wallets_configured: wallets.length,
      crypoverse_enabled: Boolean(process.env.CRYPOVERSE_API_KEY),
      crypoverse_listeners_active: getListenerCount(),
    },
    plan_prices_usd: { monthly: 20, annual: 200, lifetime: 500 },
    poller_interval_seconds: 30,
    env: {
      btc_wallet_set: Boolean(process.env.BTC_WALLET_ADDRESS),
      ltc_wallet_set: Boolean(process.env.LTC_WALLET_ADDRESS),
      eth_wallet_set: Boolean(process.env.ETH_WALLET_ADDRESS),
      etherscan_api_key: Boolean(process.env.ETHERSCAN_API_KEY),
      crypoverse_api_key: Boolean(process.env.CRYPOVERSE_API_KEY),
    },
  }
}
