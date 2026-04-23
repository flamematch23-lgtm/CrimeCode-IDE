import { Log } from "../util/log"
import type { Currency } from "./prices"
import { DECIMALS } from "./prices"
import { getWallet, getWallets } from "./wallets"

const log = Log.create({ service: "license-payments" })

export interface IncomingTx {
  txid: string
  /** Smallest unit (satoshi for BTC/LTC, wei for ETH). */
  amountUnits: bigint
  confirmations: number
  /** Unix seconds. May be 0 for unconfirmed. */
  blockTime: number
}

interface MempoolTx {
  txid: string
  status: { confirmed: boolean; block_time?: number; block_height?: number }
  vout: Array<{ scriptpubkey_address?: string; value: number }>
}

interface MempoolInfo {
  blocks: number
}

const ESPLORA_HOSTS: Record<"BTC" | "LTC", string> = {
  BTC: "https://mempool.space/api",
  LTC: "https://litecoinspace.org/api",
}

async function jsonFetch<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) {
      log.warn("http error", { url, status: res.status })
      return null
    }
    return (await res.json()) as T
  } catch (err) {
    log.warn("fetch error", { url, error: err instanceof Error ? err.message : String(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchEsploraTxs(currency: "BTC" | "LTC", address: string): Promise<IncomingTx[]> {
  const host = ESPLORA_HOSTS[currency]
  const txs = await jsonFetch<MempoolTx[]>(`${host}/address/${address}/txs`)
  if (!txs) return []
  const tipInfo = await jsonFetch<MempoolInfo>(`${host}/blocks/tip/height`).catch(() => null)
  const tipHeight = typeof tipInfo === "number" ? tipInfo : (tipInfo as any)?.blocks ?? 0
  const out: IncomingTx[] = []
  for (const tx of txs) {
    let totalSat = 0n
    for (const vout of tx.vout ?? []) {
      if (vout.scriptpubkey_address === address) totalSat += BigInt(vout.value)
    }
    if (totalSat === 0n) continue
    const confirmations =
      tx.status.confirmed && tx.status.block_height ? Math.max(0, tipHeight - tx.status.block_height + 1) : 0
    out.push({
      txid: tx.txid,
      amountUnits: totalSat,
      confirmations,
      blockTime: tx.status.block_time ?? 0,
    })
  }
  return out
}

interface BlockcypherTx {
  hash: string
  confirmations: number
  confirmed?: string
  outputs?: Array<{ addresses?: string[]; value: number }>
}

interface BlockcypherAddr {
  txs?: BlockcypherTx[]
  txrefs?: Array<{ tx_hash: string; value: number; confirmations: number; confirmed?: string }>
}

async function fetchEthereumTxs(address: string): Promise<IncomingTx[]> {
  // Blockcypher has a free tier (no API key, ~3 req/s, 200/h). For higher
  // volume, set ETHERSCAN_API_KEY and we'll use Etherscan instead.
  const etherscanKey = process.env.ETHERSCAN_API_KEY
  if (etherscanKey) {
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=20&sort=desc&apikey=${etherscanKey}`
    type EtherscanRes = {
      status: string
      result: Array<{ hash: string; from: string; to: string; value: string; timeStamp: string; confirmations: string; isError: string }>
    }
    const data = await jsonFetch<EtherscanRes>(url)
    if (!data || data.status !== "1") return []
    const lower = address.toLowerCase()
    return data.result
      .filter((t) => t.isError === "0" && t.to.toLowerCase() === lower && t.value !== "0")
      .map((t) => ({
        txid: t.hash,
        amountUnits: BigInt(t.value),
        confirmations: Number(t.confirmations) || 0,
        blockTime: Number(t.timeStamp) || 0,
      }))
  }
  // Free fallback — Blockcypher
  const data = await jsonFetch<BlockcypherAddr>(`https://api.blockcypher.com/v1/eth/main/addrs/${address.replace(/^0x/, "")}/full?limit=20`)
  if (!data?.txs) return []
  const lower = address.toLowerCase().replace(/^0x/, "")
  const out: IncomingTx[] = []
  for (const tx of data.txs) {
    let amount = 0n
    for (const o of tx.outputs ?? []) {
      const addrs = (o.addresses ?? []).map((a) => a.toLowerCase().replace(/^0x/, ""))
      if (addrs.includes(lower)) amount += BigInt(o.value)
    }
    if (amount === 0n) continue
    // Blockcypher returns ETH amount in gwei (10^-9 ETH); we want wei (10^-18 ETH).
    amount = amount * 10n ** 9n
    out.push({
      txid: tx.hash,
      amountUnits: amount,
      confirmations: tx.confirmations || 0,
      blockTime: tx.confirmed ? Math.floor(new Date(tx.confirmed).getTime() / 1000) : 0,
    })
  }
  return out
}

/** Fetch incoming transactions to an address, regardless of currency. */
export async function fetchIncomingTxs(currency: Currency, address: string): Promise<IncomingTx[]> {
  if (currency === "BTC" || currency === "LTC") return fetchEsploraTxs(currency, address)
  if (currency === "ETH") return fetchEthereumTxs(address)
  return []
}

/**
 * Build a BIP21 / EIP-681 URI for QR codes. When scanned by a wallet app, it
 * pre-fills the recipient and amount.
 */
export function paymentUri(currency: Currency, address: string, amountUnits: bigint): string {
  const decimals = DECIMALS[currency]
  const factor = 10n ** BigInt(decimals)
  const whole = amountUnits / factor
  const frac = (amountUnits % factor).toString().padStart(decimals, "0").replace(/0+$/, "")
  const amountStr = frac ? `${whole}.${frac}` : `${whole}`
  if (currency === "BTC") return `bitcoin:${address}?amount=${amountStr}`
  if (currency === "LTC") return `litecoin:${address}?amount=${amountStr}`
  if (currency === "ETH") return `ethereum:${address}?value=${amountUnits.toString()}`
  return address
}

export function qrCodeUrl(payload: string, size = 240): string {
  return `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(payload)}&size=${size}x${size}&margin=8&bgcolor=ffffff`
}

/**
 * Add an order-specific discriminator to a base amount so that the resulting
 * total is unique per order — letting us match incoming txs back to the right
 * pending order without HD addresses.
 *
 * Discriminator is a number in [0, 99999] derived from the order id hash; it
 * occupies the lowest 5 digits of the smallest unit, which is well below any
 * realistic price granularity but easily distinguished on-chain.
 */
export function withDiscriminator(baseUnits: bigint, orderId: string): bigint {
  let h = 0
  for (let i = 0; i < orderId.length; i++) h = ((h << 5) - h + orderId.charCodeAt(i)) | 0
  const offset = BigInt(Math.abs(h) % 100_000)
  return baseUnits + offset
}

/** Convenience wrapper to enumerate enabled wallets. */
export { getWallets, getWallet }
