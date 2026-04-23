import { Log } from "../util/log"
import type { Currency } from "./prices"

const log = Log.create({ service: "telegram-notify" })

export async function sendTelegramMessage(chatId: number, text: string, parseMode: "Markdown" = "Markdown"): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    })
  } catch (err) {
    log.warn("sendMessage failed", { error: err instanceof Error ? err.message : String(err) })
  }
}

export async function notifyNewDeviceSignIn(opts: {
  telegram_user_id: number
  device_label: string | null
  when: number
}): Promise<void> {
  const body =
    `🔐 *New device signed in to your CrimeCode account*\n\n` +
    `Device: ${opts.device_label ? "`" + opts.device_label + "`" : "_unknown_"}\n` +
    `Time: ${new Date(opts.when * 1000).toISOString()}\n\n` +
    `If this wasn't you, open the desktop/web app → *Account* → *Sign out*, then change any shared credentials.`
  await sendTelegramMessage(opts.telegram_user_id, body)
}

interface SendOpts {
  telegram_user_id: number
  license_id: string
  interval: string
  expires_at: number | null
  token: string
  currency: Currency
  tx: string
}

const EXPLORERS: Record<Currency, (tx: string) => string> = {
  BTC: (t) => `https://mempool.space/tx/${t}`,
  LTC: (t) => `https://litecoinspace.org/tx/${t}`,
  ETH: (t) => `https://etherscan.io/tx/${t}`,
}

function escapeMd(s: string): string {
  return s.replaceAll(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")
}

export async function sendCustomerToken(opts: SendOpts): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  const expLine = opts.expires_at
    ? `Expires: *${new Date(opts.expires_at * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}*`
    : "Expires: *never (lifetime)* 🎉"
  const explorer = EXPLORERS[opts.currency](opts.tx)
  const body =
    `✅ *Payment received on-chain!*\n\n` +
    `Order has been confirmed and your CrimeCode Pro license is ready.\n\n` +
    `License ID: \`${opts.license_id}\`\n` +
    `Plan: *${opts.interval}*\n` +
    `${expLine}\n` +
    `Tx: ${escapeMd(explorer)}\n\n` +
    `📋 *Activation*\n\n` +
    `Open the CrimeCode desktop app → on the Subscription screen click *"I have a license token"* → paste the token below → click *Activate*.\n\n` +
    `\`${opts.token}\`\n\n` +
    `Thanks for supporting CrimeCode 🖤`
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: opts.telegram_user_id,
        text: body,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    })
  } catch (err) {
    log.warn("sendMessage failed", { error: err instanceof Error ? err.message : String(err) })
  }
}
