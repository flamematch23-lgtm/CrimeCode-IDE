import { Log } from "../util/log"
import type { Currency } from "./prices"
import { newDeviceMessage, paymentConfirmedMessage, recallLang } from "./telegram-i18n"

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
  const lang = recallLang(opts.telegram_user_id)
  const deviceLabel = opts.device_label ? "`" + opts.device_label + "`" : lang === "it" ? "_sconosciuto_" : "_unknown_"
  const body = newDeviceMessage(lang, deviceLabel, new Date(opts.when * 1000).toISOString())
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
  const lang = recallLang(opts.telegram_user_id)
  const expDateStr = opts.expires_at
    ? new Date(opts.expires_at * 1000).toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null
  const expLine = expDateStr
    ? lang === "it"
      ? `Scadenza: *${expDateStr}*`
      : `Expires: *${expDateStr}*`
    : lang === "it"
    ? "Scadenza: *mai (a vita)* 🎉"
    : "Expires: *never (lifetime)* 🎉"
  const explorer = escapeMd(EXPLORERS[opts.currency](opts.tx))
  const body = paymentConfirmedMessage(lang, opts.license_id, opts.interval, expLine, explorer, opts.token)
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
