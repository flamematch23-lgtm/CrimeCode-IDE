import type { Currency } from "./prices"

export interface WalletConfig {
  currency: Currency
  address: string
  /** Number of confirmations required to consider a payment final. */
  minConfirmations: number
  /** "bitcoin"/"litecoin"/"ethereum" — used for the BIP21 URI prefix in QR codes. */
  uriScheme: string
}

export function getWallets(): WalletConfig[] {
  const out: WalletConfig[] = []
  const btc = process.env.BTC_WALLET_ADDRESS
  if (btc && btc.length > 10) {
    out.push({ currency: "BTC", address: btc, minConfirmations: 1, uriScheme: "bitcoin" })
  }
  const ltc = process.env.LTC_WALLET_ADDRESS
  if (ltc && ltc.length > 10) {
    out.push({ currency: "LTC", address: ltc, minConfirmations: 1, uriScheme: "litecoin" })
  }
  const eth = process.env.ETH_WALLET_ADDRESS
  if (eth && eth.length > 10) {
    out.push({ currency: "ETH", address: eth, minConfirmations: 6, uriScheme: "ethereum" })
  }
  return out
}

export function getWallet(currency: Currency): WalletConfig | undefined {
  return getWallets().find((w) => w.currency === currency)
}
