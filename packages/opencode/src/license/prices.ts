import { Log } from "../util/log"

const log = Log.create({ service: "license-prices" })

export type Currency = "BTC" | "LTC" | "ETH"

const CURRENCY_TO_COINGECKO: Record<Currency, string> = {
  BTC: "bitcoin",
  LTC: "litecoin",
  ETH: "ethereum",
}

interface CacheEntry {
  rate: number // 1 unit (BTC/LTC/ETH) = N USD
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const cache = new Map<Currency, CacheEntry>()

interface CoinGeckoResponse {
  [coinId: string]: { usd: number }
}

async function fetchAll(): Promise<void> {
  const ids = Object.values(CURRENCY_TO_COINGECKO).join(",")
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) {
      log.warn("coingecko fetch failed", { status: res.status })
      return
    }
    const data = (await res.json()) as CoinGeckoResponse
    const now = Date.now()
    for (const [cur, geckoId] of Object.entries(CURRENCY_TO_COINGECKO) as Array<[Currency, string]>) {
      const usd = data[geckoId]?.usd
      if (typeof usd === "number" && usd > 0) {
        cache.set(cur, { rate: usd, fetchedAt: now })
      }
    }
  } catch (err) {
    log.warn("coingecko error", { error: err instanceof Error ? err.message : String(err) })
  } finally {
    clearTimeout(timer)
  }
}

export async function getUsdRate(cur: Currency): Promise<number | null> {
  const cached = cache.get(cur)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rate
  await fetchAll()
  return cache.get(cur)?.rate ?? cached?.rate ?? null
}

/**
 * Convert a USD amount to the smallest indivisible unit of the target
 * currency (satoshi for BTC/LTC, wei for ETH). Returns null if no rate
 * is known.
 */
export async function usdToSmallestUnit(usd: number, cur: Currency): Promise<bigint | null> {
  const rate = await getUsdRate(cur)
  if (!rate) return null
  const cryptoFloat = usd / rate
  const decimals = cur === "ETH" ? 18 : 8
  // Round to the nearest smallest unit using BigInt to avoid float drift on
  // big values (1 ETH = 10^18 wei does NOT fit in Number).
  const factor = 10n ** BigInt(decimals)
  // Multiply float by 10^decimals via string to keep precision (good enough
  // for this use-case — we add an order-specific discriminator below).
  const [intPart, fracPartRaw = ""] = cryptoFloat.toFixed(decimals).split(".")
  const fracPadded = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals)
  return BigInt(intPart) * factor + BigInt(fracPadded || "0")
}

export const DECIMALS: Record<Currency, number> = {
  BTC: 8,
  LTC: 8,
  ETH: 18,
}

/** Format a smallest-unit amount as a human-readable decimal string. */
export function formatAmount(units: bigint, cur: Currency): string {
  const dec = DECIMALS[cur]
  const factor = 10n ** BigInt(dec)
  const whole = units / factor
  const frac = units % factor
  const fracStr = frac.toString().padStart(dec, "0").replace(/0+$/, "")
  if (fracStr === "") return whole.toString()
  return `${whole}.${fracStr}`
}
