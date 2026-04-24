import { Log } from "../util/log"
import type { Currency } from "./prices"
import { newDeviceMessage, paymentConfirmedMessage, recallLang } from "./telegram-i18n"

const log = Log.create({ service: "telegram-notify" })

function escapeMdv2(s: string): string {
  return s.replaceAll(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")
}

interface TelegramKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

type InlineKeyboard = TelegramKeyboardButton[][]

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  parseMode: "Markdown" | "MarkdownV2" = "Markdown",
  replyMarkup?: { inline_keyboard: InlineKeyboard },
): Promise<void> {
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
        reply_markup: replyMarkup,
      }),
    })
  } catch (err) {
    log.warn("sendMessage failed", { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Resolve the admin chat_id the approval notifications go to. */
function adminChatId(): number | null {
  const raw = process.env.OPENCODE_ADMIN_CHAT_ID
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Ping the admin's Telegram with a brand new pending user card. The
 * inline keyboard lets the admin approve with a 2-day or 7-day trial,
 * or reject. The callbacks are parsed by the bot's callback_query
 * handler (see telegram.ts) which calls approveCustomer/rejectCustomer
 * server-side and edits this message to show the outcome.
 */
export async function notifyAdminNewPendingUser(opts: {
  customer_id: string
  username: string | null
  telegram: string | null
  telegram_user_id: number | null
  email: string | null
  method: "password" | "telegram"
  created_at: number
}): Promise<void> {
  const chatId = adminChatId()
  if (!chatId) {
    log.warn("admin chat id not configured — cannot notify new pending user", { customer: opts.customer_id })
    return
  }

  const when = new Date(opts.created_at * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const parts: string[] = [
    "\uD83C\uDD95 *Nuovo utente in attesa di approvazione*",
    "",
    "*Customer:* `" + opts.customer_id + "`",
    "*Metodo:* " + (opts.method === "telegram" ? "Telegram sign-in" : "Username + password"),
  ]
  if (opts.username) parts.push("*Username:* `" + opts.username + "`")
  if (opts.telegram) parts.push("*Telegram:* @" + opts.telegram.replace(/^@/, ""))
  if (opts.telegram_user_id) parts.push("*TG user id:* `" + opts.telegram_user_id + "`")
  if (opts.email) parts.push("*Email:* `" + opts.email + "`")
  parts.push("*Registrato:* " + when)
  parts.push("")
  parts.push("_Scegli l'azione qui sotto. La prova inizia al momento dell'approvazione._")

  const cid = opts.customer_id
  const keyboard: InlineKeyboard = [
    [
      { text: "\u2705 Approva (2gg)", callback_data: `approve:${cid}:2` },
      { text: "\uD83C\uDF81 Approva (7gg)", callback_data: `approve:${cid}:7` },
    ],
    [{ text: "\u274C Rifiuta", callback_data: `reject:${cid}` }],
  ]

  await sendTelegramMessage(chatId, parts.join("\n"), "Markdown", { inline_keyboard: keyboard })
}

/** DM the customer when the admin approves them (if we have their tg id). */
export async function notifyUserApproved(opts: {
  telegram_user_id: number | null
  trial_days: number
}): Promise<void> {
  if (!opts.telegram_user_id) return
  const lang = recallLang(opts.telegram_user_id)
  const body =
    lang === "it"
      ? [
          "\u2705 *Account approvato!*",
          "",
          `Hai *${opts.trial_days} giorni* di prova gratuita per esplorare CrimeCode.`,
          "",
          "Torna all'app e accedi — la tua prova è gi\u00e0 attiva.",
        ].join("\n")
      : [
          "\u2705 *Account approved!*",
          "",
          `You have *${opts.trial_days} days* of free trial to explore CrimeCode.`,
          "",
          "Head back to the app and sign in — your trial is already active.",
        ].join("\n")
  await sendTelegramMessage(opts.telegram_user_id, body)
}

export async function notifyUserRejected(opts: {
  telegram_user_id: number | null
  reason: string | null
}): Promise<void> {
  if (!opts.telegram_user_id) return
  const lang = recallLang(opts.telegram_user_id)
  const reasonLine = opts.reason ? "\n\n_" + escapeMdv2(opts.reason) + "_" : ""
  const body =
    lang === "it"
      ? "\u274C *Richiesta di accesso rifiutata*\n\nContatta @OpCrime1312 per chiarimenti." + reasonLine
      : "\u274C *Access request rejected*\n\nContact @OpCrime1312 for details." + reasonLine
  await sendTelegramMessage(opts.telegram_user_id, body)
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
