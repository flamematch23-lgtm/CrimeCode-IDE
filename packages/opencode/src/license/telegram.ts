import { Log } from "../util/log"
import { captureException } from "./sentry"
import {
  approveCustomer,
  claimPinForCustomer,
  listSessionsForCustomer,
  rejectCustomer,
  revokeAllSessionsForCustomer,
} from "./auth"
import { notifyUserApproved, notifyUserRejected } from "./telegram-notify"
import { listTeamsForCustomer } from "./teams"
import { helpUser, orderCreatedMessage, pickLang, rememberLang, type Lang } from "./telegram-i18n"
import {
  attachPaymentOffer,
  cancelOrder,
  confirmOrderAndIssue,
  createOrder,
  findCustomerByIdOrTelegram,
  findOrCreateCustomerByTelegram,
  getLicense,
  getOffersForOrder,
  getOrder,
  listOrdersForUser,
  listLicenses,
  listPendingOrders,
  revokeLicense,
  statsCounts,
} from "./store"
import { CloudEventQueries } from "../sync/cloud-event-queries"
import { verifyToken } from "./token"
import { formatAmount, usdToSmallestUnit, type Currency } from "./prices"
import { paymentUri, qrCodeUrl, withDiscriminator } from "./payments"
import { getWallets } from "./wallets"

const log = Log.create({ service: "telegram-bot" })

const POLL_INTERVAL_MS = 30_000
const POLL_TIMEOUT_S = 25

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string; first_name?: string; language_code?: string }
    chat: { id: number }
    text?: string
  }
  callback_query?: {
    id: string
    from: { id: number; username?: string; first_name?: string }
    message?: {
      message_id: number
      chat: { id: number }
      text?: string
    }
    data?: string
  }
}

interface TgResponse<T> {
  ok: boolean
  description?: string
  result?: T
}

let lastUpdateId = 0
let stopped = false

function getToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null
}

function getAdminUserIds(): Set<number> {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS ?? ""
  return new Set(
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  )
}

async function tgFetch<T>(token: string, method: string, body?: object): Promise<TgResponse<T>> {
  const url = `https://api.telegram.org/bot${token}/${method}`
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return (await res.json()) as TgResponse<T>
}

async function send(chatId: number, text: string, parseMode: "Markdown" | "MarkdownV2" | undefined = undefined) {
  const token = getToken()
  if (!token) return
  const r = await tgFetch<unknown>(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  })
  if (!r.ok) log.warn("sendMessage failed", { description: r.description })
}

const HELP_USER = `🔥 *Welcome to CrimeCode* 🔥

The IDE built for fraud researchers and security pros — by the team, for the team.

🏷️ *Plans*

⚡ *Monthly* — *$20 / month*
   Try the platform. All Pro features unlocked, cancel anytime.

🔥 *Annual* — *$200 / year* _(save ~17%)_
   For serious users. Two months free vs paying monthly.

💎 *Lifetime* — *$500 once* _(best value)_
   Pay once, keep forever. All future updates included.

📋 *How it works (fully automated)*

*1.* Run \`/order monthly\` — _or_ \`annual\` _or_ \`lifetime\`.
*2.* The bot replies with three wallets (BTC / LTC / ETH) and the *exact* amount to send for each.
*3.* Send the EXACT amount to ANY one of those wallets.
*4.* As soon as the transaction is confirmed on-chain (~1–15 min) you receive your license token here automatically. ⚡

📌 *Useful commands*
\`/start\` — show this message
\`/order monthly|annual|lifetime\` — create a new order
\`/status <order_id>\` — check the status of one of your orders
\`/myorders\` — list your last orders
\`/teams\` — list your teams

🔒 *Privacy*
We store only your Telegram handle, your order, and the license token signature. No email, no card data, no KYC.

🆘 *Need a human?* Message @OpCrime1312 or @JollyFraud — quote your order ID.`

const HELP_ADMIN = `🛠️ *Admin commands* (you only)

*Orders & licenses*
\`/confirm <order_id> [tx_hash]\` — confirm payment + auto-deliver token
\`/cancel <order_id>\` — cancel a pending order
\`/pending\` — list pending orders
\`/list\` — last 20 licenses
\`/revoke <license_id> [reason]\` — revoke a license
\`/lookup <token>\` — find license by token

*Customers & sessions*
\`/whois <cus_id|@telegram|user_id>\` — full customer dump
\`/forcelogout <cus_id|@telegram|user_id>\` — kick every device for this customer

*Cloud sync*
\`/syncstats\` — global cloud-event stats + top 10 customers
\`/wipesync <cus_id|@telegram|user_id>\` — *DESTRUCTIVE* wipe all cloud events for a customer (GDPR)

*Counters*
\`/stats\` — counters dashboard

Dashboard web: \`https://api.crimecode.cc/license/admin\``

const PRICE_USD: Record<"monthly" | "annual" | "lifetime", number> = {
  monthly: 20,
  annual: 200,
  lifetime: 500,
}

const PAY_WINDOW_MINUTES = 60

const CURRENCY_EMOJI: Record<Currency, string> = {
  BTC: "🟠",
  LTC: "🪙",
  ETH: "🔷",
}

interface OfferDetail {
  currency: Currency
  units: bigint
  address: string
  amountStr: string
  uri: string
  qr: string
}

async function buildOfferLines(orderId: string, usd: number): Promise<{ lines: string[]; offers: OfferDetail[] }> {
  const wallets = getWallets()
  const out: OfferDetail[] = []
  const lines: string[] = []
  for (const w of wallets) {
    const baseUnits = await usdToSmallestUnit(usd, w.currency)
    if (baseUnits == null) continue
    const units = withDiscriminator(baseUnits, orderId)
    const amountStr = formatAmount(units, w.currency)
    const uri = paymentUri(w.currency, w.address, units)
    const qr = qrCodeUrl(uri)
    out.push({ currency: w.currency, units, address: w.address, amountStr, uri, qr })
    lines.push(
      `${CURRENCY_EMOJI[w.currency]} *${w.currency}* — send EXACTLY \`${amountStr}\` ${w.currency}\n` +
        `   \`${w.address}\`\n` +
        `   [Open in wallet](${uri}) · [QR](${qr})`,
    )
  }
  return { lines, offers: out }
}

async function newOrderMessage(
  orderId: string,
  interval: keyof typeof PRICE_USD,
  lang: Lang = "en",
): Promise<string> {
  const usd = PRICE_USD[interval]
  const expires = Math.floor(Date.now() / 1000) + PAY_WINDOW_MINUTES * 60
  const { lines, offers } = await buildOfferLines(orderId, usd)
  // Persist offers so the poller can match incoming txs.
  for (const o of offers) {
    attachPaymentOffer({
      order_id: orderId,
      currency: o.currency,
      expected_units: o.units,
      wallet_address: o.address,
      expires_at: expires,
    })
  }
  return orderCreatedMessage(lang, orderId, interval, usd, lines.join("\n\n"), PAY_WINDOW_MINUTES)
}

function tokenDeliveryMessage(licenseId: string, interval: string, expiresAt: number | null, token: string): string {
  const exp = expiresAt
    ? `\nExpires: *${new Date(expiresAt * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}*`
    : "\nExpires: *never (lifetime)* 🎉"
  return `🎉 *Your CrimeCode license is ready!*

License ID: \`${licenseId}\`
Plan: *${interval}*${exp}

📋 *Activation*

Open the CrimeCode desktop app → on the Subscription screen click *"I have a token"* → paste the token below → click *Activate*.

\`${token}\`

(Tap to copy — keep it safe, this is your proof of purchase.)

Thanks for supporting CrimeCode 🖤`
}

const VALID_INTERVALS = new Set(["monthly", "annual", "lifetime"])

function escapeMd(s: string): string {
  return s.replaceAll(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1")
}

async function handleCallbackQuery(update: TgUpdate): Promise<void> {
  const cb = update.callback_query
  if (!cb || !cb.data) return
  const token = getToken()
  const fromId = cb.from.id

  // Only the admin(s) can approve/reject users.
  const isAdmin = getAdminUserIds().has(fromId)
  if (!isAdmin) {
    if (token) {
      await tgFetch<unknown>(token, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Non autorizzato",
        show_alert: true,
      })
    }
    return
  }

  // approve:<cid>:<days>   reject:<cid>
  const approveMatch = cb.data.match(/^approve:(cus_[A-Za-z0-9_-]{4,32}):(\d{1,3})$/)
  const rejectMatch = cb.data.match(/^reject:(cus_[A-Za-z0-9_-]{4,32})$/)

  let outcomeText: string | null = null
  if (approveMatch) {
    const [, cid, daysStr] = approveMatch
    const days = Number.parseInt(daysStr, 10)
    const r = approveCustomer(cid, { trialDays: days, approvedBy: `bot:${fromId}` })
    if (!r) {
      outcomeText = "Customer non trovato"
    } else {
      outcomeText = `✅ Approvato con ${days}gg di prova` + (r.was_already_approved ? " (era già approvato)" : "")
      void notifyUserApproved({ telegram_user_id: r.telegram_user_id, trial_days: days }).catch(() => undefined)
    }
  } else if (rejectMatch) {
    const [, cid] = rejectMatch
    const r = rejectCustomer(cid, { rejectedBy: `bot:${fromId}`, reason: null })
    if (!r) {
      outcomeText = "Customer non trovato"
    } else {
      outcomeText = "❌ Rifiutato"
      void notifyUserRejected({ telegram_user_id: r.telegram_user_id, reason: null }).catch(() => undefined)
    }
  } else {
    outcomeText = "Azione sconosciuta"
  }

  if (!token) return

  // 1. Acknowledge the button press with a toast notification.
  await tgFetch<unknown>(token, "answerCallbackQuery", {
    callback_query_id: cb.id,
    text: outcomeText,
  })

  // 2. Edit the original message so the chat history shows the final
  //    outcome instead of the now-consumed buttons.
  if (cb.message) {
    const original = cb.message.text ?? ""
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
    const adminHandle = cb.from.username ? "@" + cb.from.username : String(fromId)
    const newText = `${original}\n\n— ${outcomeText} (${adminHandle}, ${stamp})`
    await tgFetch<unknown>(token, "editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: newText,
      parse_mode: "Markdown",
    })
  }
}

async function handle(update: TgUpdate) {
  if (update.callback_query) {
    await handleCallbackQuery(update)
    return
  }
  const msg = update.message
  if (!msg || !msg.text || !msg.from) return
  const chatId = msg.chat.id
  const userId = msg.from.id
  const username = msg.from.username ? `@${msg.from.username}` : null
  const text = msg.text.trim()
  const isAdmin = getAdminUserIds().has(userId)
  const lang = pickLang(msg.from.language_code)
  rememberLang(userId, lang) // cache for async messages (reminders, notifications)

  log.info("telegram message", { from: userId, username, lang, text: text.slice(0, 80) })

  const cmdMatch = text.match(/^\/([a-zA-Z]+)(?:@\w+)?(?:\s+(.*))?$/)
  if (!cmdMatch) {
    await send(chatId, helpUser(lang), "Markdown")
    return
  }
  const cmd = cmdMatch[1].toLowerCase()
  const args = (cmdMatch[2] ?? "").trim()

  // Make sure this user is in the customers table (idempotent).
  if (username || userId) {
    findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
  }

  switch (cmd) {
    case "start":
    case "help": {
      // Telegram deep-link payload variants:
      //   /start order_<interval>   — create a paid order
      //   /start auth_<PIN>          — link the desktop/web client session
      const deepLinkInterval = args.match(/^order_(monthly|annual|lifetime)\b/)?.[1]
      if (deepLinkInterval && VALID_INTERVALS.has(deepLinkInterval)) {
        const o = createOrder({
          customer_telegram: username,
          customer_user_id: userId,
          interval: deepLinkInterval as "monthly" | "annual" | "lifetime",
        })
        await send(chatId, await newOrderMessage(o.id, o.interval as keyof typeof PRICE_USD, lang), "Markdown")
        return
      }
      const authPin = args.match(/^auth_([A-Z0-9]{4,32})\b/i)?.[1]
      if (authPin) {
        const customer = findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
        const r = claimPinForCustomer(authPin.toUpperCase(), customer.id)
        if (r.ok) {
          await send(
            chatId,
            `✅ *Signed in*\n\nYou are now logged in${username ? ` as *${username}*` : ""} on the device that started this PIN. You can close this chat.`,
            "Markdown",
          )
        } else {
          const reasons: Record<string, string> = {
            unknown_pin: "PIN not found — it may have already been used.",
            expired: "PIN expired — go back to the app and request a new one.",
            already_claimed: "PIN already claimed.",
          }
          await send(chatId, `⚠️ Sign-in failed: ${reasons[r.reason] ?? r.reason}`)
        }
        return
      }
      await send(chatId, helpUser(lang) + (isAdmin ? "\n\n" + HELP_ADMIN : ""), "Markdown")
      return
    }
    case "order": {
      const interval = args.toLowerCase()
      if (!VALID_INTERVALS.has(interval)) {
        await send(chatId, "Usage: `/order monthly|annual|lifetime`", "Markdown")
        return
      }
      const o = createOrder({
        customer_telegram: username,
        customer_user_id: userId,
        interval: interval as "monthly" | "annual" | "lifetime",
      })
      await send(chatId, await newOrderMessage(o.id, o.interval as keyof typeof PRICE_USD, lang), "Markdown")
      return
    }
    case "status": {
      if (!args) { await send(chatId, "Usage: `/status <order_id>`", "Markdown"); return }
      const o = getOrder(args)
      if (!o) { await send(chatId, "Order not found."); return }
      if (o.customer_user_id && o.customer_user_id !== userId && !isAdmin) {
        await send(chatId, "You are not the owner of this order.")
        return
      }
      let body = `Order *${o.id}*\nPlan: *${o.interval}*\nStatus: *${o.status}*`
      if (o.tx_hash) body += `\ntx: \`${escapeMd(o.tx_hash)}\``
      if (o.license_id) body += `\nLicense: \`${o.license_id}\``
      await send(chatId, body, "Markdown")
      return
    }
    case "teams": {
      const customer = findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
      const teams = listTeamsForCustomer(customer.id)
      if (teams.length === 0) {
        await send(
          chatId,
          "You're not in any team yet. Ask an admin to invite you, or create one from the CrimeCode desktop app (*Personal ▸ Create Team*).",
          "Markdown",
        )
        return
      }
      const lines = teams.map(
        (t) => `• *${escapeMd(t.name)}* — role: *${t.role}*, members: ${t.member_count}`,
      )
      await send(chatId, "Your teams:\n" + lines.join("\n"), "Markdown")
      return
    }
    case "myorders": {
      const orders = listOrdersForUser(userId, 10)
      if (orders.length === 0) { await send(chatId, "You have no orders yet. Try `/order monthly`.", "Markdown"); return }
      const lines = orders.map((o) => `• \`${o.id}\` — ${o.interval} — *${o.status}*`)
      await send(chatId, "Your last orders:\n" + lines.join("\n"), "Markdown")
      return
    }

    // ── Account & sync (user-facing) ──
    case "devices": {
      const customer = findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
      const sessions = listSessionsForCustomer(customer.id)
      const active = sessions.filter((s) => s.revoked_at == null)
      if (active.length === 0) {
        await send(chatId, "You have no active sessions. Sign in from the desktop or web app to get started.")
        return
      }
      const lines = active.map((s) => {
        const last = new Date(s.last_seen_at * 1000).toISOString().replace("T", " ").slice(0, 16)
        const id = s.id.length > 18 ? s.id.slice(0, 8) + "…" + s.id.slice(-6) : s.id
        return `• \`${id}\` — ${escapeMd(s.device_label ?? "unknown device")} — last seen *${last}* UTC`
      })
      await send(
        chatId,
        `🔐 *Active devices* (${active.length})\n\n${lines.join("\n")}\n\nUse \`/logout\` to sign out everywhere.`,
        "Markdown",
      )
      return
    }
    case "logout": {
      const customer = findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
      const n = revokeAllSessionsForCustomer(customer.id)
      if (n === 0) {
        await send(chatId, "You have no active sessions to sign out.")
      } else {
        await send(
          chatId,
          `✅ Signed out *${n}* device${n === 1 ? "" : "s"}. You'll need to sign in again on each one.`,
          "Markdown",
        )
      }
      return
    }
    case "sync": {
      const customer = findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
      const stats = CloudEventQueries.statsForCustomer(customer.id)
      if (stats.totalEvents === 0) {
        await send(
          chatId,
          "☁️ *Cloud sync*\n\nYou don't have any synced data yet. Sign in to the desktop app and your sessions will start syncing automatically.",
          "Markdown",
        )
        return
      }
      const top = CloudEventQueries.topAggregatesForCustomer(customer.id, 5)
      const last = stats.lastPushedAt
        ? new Date(stats.lastPushedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC"
        : "never"
      const first = stats.firstPushedAt
        ? new Date(stats.firstPushedAt).toISOString().replace("T", " ").slice(0, 10)
        : "—"
      const topLines = top.map(
        (a) =>
          `• \`${a.aggregate_id.length > 24 ? a.aggregate_id.slice(0, 22) + "…" : a.aggregate_id}\` — ${a.eventCount} events`,
      )
      const body =
        `☁️ *Your cloud sync*\n\n` +
        `Total events: *${stats.totalEvents}*\n` +
        `Aggregates: *${stats.uniqueAggregates}* (sessions/projects)\n` +
        `First sync: *${first}*\n` +
        `Last sync: *${last}*\n\n` +
        `*Recent activity*\n${topLines.join("\n")}`
      await send(chatId, body, "Markdown")
      return
    }

    // ── Admin ──
    case "confirm": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const parts = args.split(/\s+/).filter(Boolean)
      const orderId = parts[0]
      const txHash = parts.slice(1).join(" ") || null
      if (!orderId) { await send(chatId, "Usage: `/confirm <order_id> [tx_hash]`", "Markdown"); return }
      const r = confirmOrderAndIssue({ order_id: orderId, tx_hash: txHash })
      if ("error" in r) { await send(chatId, "Error: " + r.error); return }
      // notify customer (use their remembered locale if we've seen them)
      if (r.customer.telegram_user_id) {
        await send(
          r.customer.telegram_user_id,
          tokenDeliveryMessage(r.license.id, r.license.interval, r.license.expires_at, r.token),
          "Markdown",
        )
        // ^^ the helper defined in this file is EN-only for the admin
        // surface; the poller path (payments auto-detected on-chain) uses
        // the i18n helper instead. Kept this branch EN since the admin
        // explicitly typed /confirm and the receipt tone is identical.
      }
      const who = r.customer.telegram ?? (r.customer.telegram_user_id ? `user ${r.customer.telegram_user_id}` : "customer")
      await send(
        chatId,
        `✅ Confirmed order \`${r.order.id}\` → license \`${r.license.id}\` delivered to ${who}.\n\nToken (for your records):\n\`${r.token}\``,
        "Markdown",
      )
      return
    }
    case "cancel": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      if (!args) { await send(chatId, "Usage: `/cancel <order_id>`", "Markdown"); return }
      const r = cancelOrder(args)
      if (!r) { await send(chatId, "Order not found or not pending."); return }
      await send(chatId, `Cancelled order *${r.id}*.`, "Markdown")
      return
    }
    case "pending": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const orders = listPendingOrders(20)
      if (orders.length === 0) { await send(chatId, "No pending orders."); return }
      const lines = orders.map((o) => `• \`${o.id}\` — ${o.interval} — ${o.customer_telegram ?? "?"}`)
      await send(chatId, "Pending orders:\n" + lines.join("\n"), "Markdown")
      return
    }
    case "list": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const ls = listLicenses(20)
      if (ls.length === 0) { await send(chatId, "No licenses yet."); return }
      const lines = ls.map(
        (l) => `• \`${l.id}\` — ${l.interval} — ${l.customer_telegram ?? l.customer_id} — ${l.revoked_at ? "revoked" : "active"}`,
      )
      await send(chatId, "Last licenses:\n" + lines.join("\n"), "Markdown")
      return
    }
    case "revoke": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const parts = args.split(/\s+/).filter(Boolean)
      const id = parts[0]
      const reason = parts.slice(1).join(" ") || null
      if (!id) { await send(chatId, "Usage: `/revoke <license_id> [reason]`", "Markdown"); return }
      const r = revokeLicense(id, reason)
      if (!r) { await send(chatId, "License not found."); return }
      await send(chatId, `Revoked *${r.id}*.${reason ? " Reason: " + reason : ""}`, "Markdown")
      return
    }
    case "lookup": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      if (!args) { await send(chatId, "Usage: `/lookup <token>`", "Markdown"); return }
      const v = verifyToken(args)
      if (!v.ok || !v.payload) { await send(chatId, "Invalid token: " + (v.reason ?? "unknown")); return }
      const lic = getLicense(v.payload.l)
      if (!lic) { await send(chatId, "Token signature valid but license not in DB."); return }
      const status = lic.revoked_at
        ? "revoked"
        : lic.expires_at && lic.expires_at <= Math.floor(Date.now() / 1000)
        ? "expired"
        : "active"
      await send(
        chatId,
        `License *${lic.id}*\nCustomer: \`${lic.customer_id}\`\nPlan: *${lic.interval}*\nStatus: *${status}*\nIssued: ${new Date(lic.issued_at * 1000).toISOString()}`,
        "Markdown",
      )
      return
    }
    case "stats": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const s = statsCounts()
      await send(
        chatId,
        Object.entries(s).map(([k, v]) => `${k}: *${v}*`).join("\n"),
        "Markdown",
      )
      return
    }
    case "whois": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      if (!args) { await send(chatId, "Usage: `/whois <cus_id|@telegram|user_id>`", "Markdown"); return }
      const c = findCustomerByIdOrTelegram(args)
      if (!c) { await send(chatId, "Customer not found."); return }
      const sessions = listSessionsForCustomer(c.id)
      const active = sessions.filter((s) => s.revoked_at == null)
      const sync = CloudEventQueries.statsForCustomer(c.id)
      const teams = listTeamsForCustomer(c.id)
      const created = new Date(c.created_at * 1000).toISOString().replace("T", " ").slice(0, 16)
      const lastSync = sync.lastPushedAt
        ? new Date(sync.lastPushedAt).toISOString().replace("T", " ").slice(0, 16)
        : "never"
      const body =
        `👤 *Customer dump*\n\n` +
        `ID: \`${c.id}\`\n` +
        `Telegram: ${c.telegram ? "@" + escapeMd(c.telegram) : "_none_"}` +
        (c.telegram_user_id ? ` (\`${c.telegram_user_id}\`)` : "") +
        `\n` +
        `Email: ${c.email ? escapeMd(c.email) : "_none_"}\n` +
        `Status: *${c.approval_status}*` +
        (c.rejected_reason ? ` (${escapeMd(c.rejected_reason)})` : "") +
        `\n` +
        `Created: *${created}* UTC\n` +
        `\n` +
        `Sessions: *${active.length}* active / *${sessions.length}* total\n` +
        `Teams: *${teams.length}*\n` +
        `Cloud events: *${sync.totalEvents}* across *${sync.uniqueAggregates}* aggregates — last push *${lastSync}* UTC\n` +
        `\n` +
        `Use \`/forcelogout ${c.id}\` to kick all devices, \`/wipesync ${c.id}\` to drop their cloud data.`
      await send(chatId, body, "Markdown")
      return
    }
    case "forcelogout": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      if (!args) { await send(chatId, "Usage: `/forcelogout <cus_id|@telegram|user_id>`", "Markdown"); return }
      const c = findCustomerByIdOrTelegram(args)
      if (!c) { await send(chatId, "Customer not found."); return }
      const n = revokeAllSessionsForCustomer(c.id)
      await send(chatId, `🔌 Revoked *${n}* session${n === 1 ? "" : "s"} for \`${c.id}\`.`, "Markdown")
      return
    }
    case "syncstats": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const g = CloudEventQueries.globalStats()
      const top = CloudEventQueries.topCustomers(10)
      const lines = top.map((r, i) => {
        const last = new Date(r.lastPushedAt).toISOString().slice(0, 10)
        return `${i + 1}. \`${r.customer_id}\` — *${r.eventCount}* events (last ${last})`
      })
      const body =
        `☁️ *Cloud-event log — global*\n\n` +
        `Total events: *${g.totalEvents}*\n` +
        `Unique customers syncing: *${g.uniqueCustomers}*\n` +
        `Unique aggregates: *${g.uniqueAggregates}*\n\n` +
        (lines.length > 0 ? `*Top 10 customers*\n${lines.join("\n")}` : "_No customers have synced yet._")
      await send(chatId, body, "Markdown")
      return
    }
    case "wipesync": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      if (!args) { await send(chatId, "Usage: `/wipesync <cus_id|@telegram|user_id>`", "Markdown"); return }
      const c = findCustomerByIdOrTelegram(args)
      if (!c) { await send(chatId, "Customer not found."); return }
      const before = CloudEventQueries.statsForCustomer(c.id).totalEvents
      const deleted = CloudEventQueries.wipeCustomer(c.id)
      await send(
        chatId,
        `🗑️ Wiped *${deleted}* cloud event${deleted === 1 ? "" : "s"} for \`${c.id}\` (was ${before}).`,
        "Markdown",
      )
      return
    }
    default:
      await send(chatId, helpUser(lang) + (isAdmin ? "\n\n" + HELP_ADMIN : ""), "Markdown")
  }
}

async function pollOnce(token: string) {
  const r = await tgFetch<TgUpdate[]>(token, "getUpdates", {
    offset: lastUpdateId + 1,
    timeout: POLL_TIMEOUT_S,
    allowed_updates: ["message", "callback_query"],
  })
  if (!r.ok) {
    log.warn("getUpdates failed", { description: r.description })
    return
  }
  const updates = r.result ?? []
  for (const u of updates) {
    lastUpdateId = Math.max(lastUpdateId, u.update_id)
    try {
      await handle(u)
    } catch (e) {
      log.error("handler error", { error: e instanceof Error ? e.message : String(e) })
      captureException(e, {
        tags: { surface: "telegram-bot", command: u.message?.text?.split(/\s+/)[0]?.slice(0, 24) ?? "_unknown_" },
        extra: { from_user_id: u.message?.from?.id ?? null },
      })
    }
  }
}

export function startTelegramBot(): void {
  const token = getToken()
  if (!token) {
    log.info("TELEGRAM_BOT_TOKEN not set — bot disabled")
    return
  }
  log.info("starting Telegram bot", { admins: getAdminUserIds().size })
  ;(async () => {
    while (!stopped) {
      try {
        await pollOnce(token)
      } catch (e) {
        log.warn("poll error, backoff", { error: e instanceof Error ? e.message : String(e) })
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
    }
  })().catch((e) => log.error("bot loop crashed", { error: e instanceof Error ? e.message : String(e) }))
}

export function stopTelegramBot(): void {
  stopped = true
}
