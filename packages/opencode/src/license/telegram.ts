import { Log } from "../util/log"
import { captureException } from "./sentry"
import {
  approveCustomer,
  claimPinForCustomer,
  listPendingCustomers,
  listSessionsForCustomer,
  rejectCustomer,
  revokeAllSessionsForCustomer,
  revokeSession,
} from "./auth"
import { notifyAdminNewPendingUser, notifyUserApproved, notifyUserRejected } from "./telegram-notify"
import { listTeamsForCustomer } from "./teams"
import { helpUser, orderCreatedMessage, pickLang, recallLang, rememberLang, type Lang } from "./telegram-i18n"
import {
  attachPaymentOffer,
  cancelOrder,
  confirmOrderAndIssue,
  createOrder,
  findCustomerByIdOrTelegram,
  findCustomerByTelegram,
  findOrCreateCustomerByTelegram,
  getActiveLicenseForCustomer,
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
import {
  claimReferral,
  getOrCreateReferralCode,
  listReferralsByCustomer,
  REFERRAL_BONUS,
} from "./referrals"
import { makeToken, verifyToken } from "./token"
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

// Inline-keyboard primitive used by every command that wants buttons.
// Telegram's `reply_markup.inline_keyboard` is a 2D array of buttons; each
// button has either `callback_data` (handled in handleCallbackQuery) or
// `url` (just opens the link). Keep callback_data ≤ 64 bytes — the
// Telegram API rejects longer values silently.
type TgButton = { text: string; callback_data?: string; url?: string }
type TgKeyboard = TgButton[][]

async function send(
  chatId: number,
  text: string,
  parseMode: "Markdown" | "MarkdownV2" | undefined = undefined,
  keyboard?: TgKeyboard,
) {
  const token = getToken()
  if (!token) return
  const r = await tgFetch<unknown>(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
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

*Approvals*
\`/pendingusers\` — list customers awaiting approval
\`/approve <cus_id|@telegram|user_id> [days=2]\` — approve + start trial
\`/reject <cus_id|@telegram|user_id> [reason]\` — reject the request
   _Tip: when a new user signs up, the bot DMs you a card with inline_
   _approve/reject buttons. These commands cover the same flow on demand._

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
  const fromUsername = cb.from.username ? `@${cb.from.username}` : null

  // Three callback-data namespaces:
  //   adm:<verb>[:args…]  — admin-only actions (approve, reject, confirm…)
  //   usr:<verb>[:args…]  — actions on the caller's own data
  //   menu:<verb>[:args…] — show another command's output as a fresh msg
  // Plus the legacy `approve:<cid>:<days>` / `reject:<cid>` patterns from
  // notifications still in flight at deploy time — kept for ~7 days.
  const data = cb.data
  const ack = async (text: string, alert = false) => {
    if (!token) return
    await tgFetch<unknown>(token, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: text.slice(0, 200),
      show_alert: alert,
    })
  }
  const editOriginal = async (suffix: string) => {
    if (!token || !cb.message) return
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
    const who = fromUsername ?? String(fromId)
    await tgFetch<unknown>(token, "editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: `${cb.message.text ?? ""}\n\n— ${suffix} (${who}, ${stamp})`,
      parse_mode: "Markdown",
    })
  }
  const sendNew = async (chatId: number, text: string, kb?: TgKeyboard) => {
    await send(chatId, text, "Markdown", kb)
  }

  const isAdmin = getAdminUserIds().has(fromId)

  // ─── Admin actions ───────────────────────────────────────────────────
  // Both the new `adm:` prefix and the legacy bareword commands route here.
  const isAdminAction =
    data.startsWith("adm:") ||
    data.startsWith("approve:") ||
    data.startsWith("reject:")
  if (isAdminAction) {
    if (!isAdmin) {
      await ack("Non autorizzato", true)
      return
    }
    const stripped = data.startsWith("adm:") ? data.slice(4) : data
    const [verb, a1, a2] = stripped.split(":")

    if (verb === "approve" && a1 && a2) {
      const days = Number.parseInt(a2, 10)
      const r = approveCustomer(a1, { trialDays: days, approvedBy: `bot:${fromId}` })
      if (!r) return ack("Customer non trovato", true)
      const outcome =
        `✅ Approvato con ${days}gg di prova` + (r.was_already_approved ? " (era già approvato)" : "")
      void notifyUserApproved({ telegram_user_id: r.telegram_user_id, trial_days: days }).catch(() => undefined)
      await ack(outcome)
      await editOriginal(outcome)
      return
    }
    if (verb === "reject" && a1) {
      const r = rejectCustomer(a1, { rejectedBy: `bot:${fromId}`, reason: null })
      if (!r) return ack("Customer non trovato", true)
      void notifyUserRejected({ telegram_user_id: r.telegram_user_id, reason: null }).catch(() => undefined)
      await ack("❌ Rifiutato")
      await editOriginal("❌ Rifiutato")
      return
    }
    if (verb === "ordconf" && a1) {
      const r = confirmOrderAndIssue({ order_id: a1, tx_hash: null })
      if ("error" in r) return ack("Error: " + r.error, true)
      if (r.customer.telegram_user_id) {
        await send(
          r.customer.telegram_user_id,
          tokenDeliveryMessage(r.license.id, r.license.interval, r.license.expires_at, r.token),
          "Markdown",
        )
      }
      await ack(`✅ Confermato → ${r.license.id}`)
      await editOriginal(`✅ Confermato → license \`${r.license.id}\``)
      return
    }
    if (verb === "ordcancel" && a1) {
      const o = cancelOrder(a1)
      if (!o) return ack("Order not found / not pending", true)
      await ack("Cancelled")
      await editOriginal(`🚫 Cancelled \`${o.id}\``)
      return
    }
    if (verb === "licrevoke" && a1) {
      const r = revokeLicense(a1, "via bot button")
      if (!r) return ack("License not found", true)
      await ack("License revoked")
      await editOriginal(`🚫 Revoked \`${r.id}\``)
      return
    }
    return ack("Azione sconosciuta", true)
  }

  // ─── User actions on their own data ──────────────────────────────────
  if (data.startsWith("usr:")) {
    const [, verb, a1] = data.split(":")
    const customer = findCustomerByTelegram({ telegram_user_id: fromId })
    if (!customer) return ack("Account non trovato — riavvia con /start", true)
    if (verb === "logoutall") {
      const n = revokeAllSessionsForCustomer(customer.id)
      await ack(`✅ Disconnessi ${n} dispositivi`)
      await editOriginal(`✅ Disconnessi *${n}* dispositivi`)
      return
    }
    if (verb === "logoutdev" && a1) {
      const sessions = listSessionsForCustomer(customer.id)
      const own = sessions.find((s) => s.id === a1 && s.revoked_at == null)
      if (!own) return ack("Sessione non trovata o già chiusa", true)
      revokeSession(a1)
      await ack("✅ Sessione chiusa")
      await editOriginal(`✅ Sessione \`${a1.slice(0, 12)}…\` chiusa`)
      return
    }
    if (verb === "cancelmyord" && a1) {
      const o = getOrder(a1)
      if (!o || (o.customer_user_id && o.customer_user_id !== fromId)) {
        return ack("Ordine non trovato o non tuo", true)
      }
      const cancelled = cancelOrder(a1)
      if (!cancelled) return ack("Ordine non in pending — non si può cancellare", true)
      await ack("Ordine cancellato")
      await editOriginal(`🚫 Ordine \`${a1}\` cancellato`)
      return
    }
    return ack("Azione sconosciuta", true)
  }

  // ─── Menu shortcuts (open a command's output as a new message) ───────
  if (data.startsWith("menu:")) {
    const [, verb, a1] = data.split(":")
    if (!cb.message) return ack("ok")
    const chatId = cb.message.chat.id
    if (verb === "order" && (a1 === "monthly" || a1 === "annual" || a1 === "lifetime")) {
      const customer = findCustomerByTelegram({ telegram_user_id: fromId })
      const lang = recallLang(fromId)
      const o = createOrder({
        customer_telegram: customer?.telegram ?? fromUsername?.replace(/^@/, "") ?? null,
        customer_user_id: fromId,
        interval: a1,
      })
      await sendNew(chatId, await newOrderMessage(o.id, o.interval as keyof typeof PRICE_USD, lang))
      await ack("Ordine creato")
      return
    }
    if (verb === "mylicense") {
      const cust = findCustomerByTelegram({ telegram_user_id: fromId })
      const lic = cust ? getActiveLicenseForCustomer(cust.id) : null
      if (!lic) {
        await sendNew(chatId, "📭 No active license — pick a plan with /order monthly|annual|lifetime.")
      } else {
        const { token: licTok } = makeToken({
          l: lic.id,
          i: lic.interval,
          t: lic.issued_at,
          ...(lic.expires_at != null ? { e: lic.expires_at } : {}),
        })
        const exp = lic.expires_at
          ? `\nExpires: *${new Date(lic.expires_at * 1000).toISOString().slice(0, 10)}*`
          : "\nExpires: *never (lifetime)* 🎉"
        await sendNew(
          chatId,
          `🎟️ *Your license*\n\nID: \`${lic.id}\`\nPlan: *${lic.interval}*${exp}\n\n\`${licTok}\``,
        )
      }
      await ack("ok")
      return
    }
    if (verb === "myorders") {
      const orders = listOrdersForUser(fromId, 5)
      if (orders.length === 0) {
        await sendNew(chatId, "📋 *No orders yet*. Tap /order monthly|annual|lifetime to start one.")
      } else {
        const lines = orders.map((o) => `• \`${o.id}\` — ${o.interval} — *${o.status}*`)
        await sendNew(chatId, "📋 *Your last orders*\n\n" + lines.join("\n"))
      }
      await ack("ok")
      return
    }
    if (verb === "devices") {
      const cust = findCustomerByTelegram({ telegram_user_id: fromId })
      const sessions = cust ? listSessionsForCustomer(cust.id).filter((s) => s.revoked_at == null) : []
      if (sessions.length === 0) {
        await sendNew(chatId, "🔐 No active devices. Sign in from the desktop or web app.")
      } else {
        const lines = sessions
          .map((s) => `• ${escapeMd(s.device_label ?? "unknown")} — last seen ${new Date(s.last_seen_at * 1000).toISOString().slice(0, 16)} UTC`)
        await sendNew(chatId, `🔐 *Active devices* (${sessions.length})\n\n` + lines.join("\n"), [
          [{ text: "🔌 Logout everywhere", callback_data: "usr:logoutall" }],
        ])
      }
      await ack("ok")
      return
    }
    if (verb === "teams") {
      const cust = findCustomerByTelegram({ telegram_user_id: fromId })
      const teams = cust ? listTeamsForCustomer(cust.id) : []
      if (teams.length === 0) {
        await sendNew(chatId, "You're not in any team yet.")
      } else {
        const lines = teams.map((t) => `• *${escapeMd(t.name)}* — role *${t.role}* — ${t.member_count} members`)
        await sendNew(chatId, "👥 *Your teams*\n\n" + lines.join("\n"))
      }
      await ack("ok")
      return
    }
    if (verb === "sync") {
      const cust = findCustomerByTelegram({ telegram_user_id: fromId })
      if (!cust) {
        await sendNew(chatId, "No CrimeCode account linked yet.")
      } else {
        const { CloudEventQueries } = await import("../sync/cloud-event-queries")
        const stats = CloudEventQueries.statsForCustomer(cust.id)
        const last = stats.lastPushedAt
          ? new Date(stats.lastPushedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC"
          : "never"
        await sendNew(
          chatId,
          `☁️ *Cloud sync*\n\nEvents: *${stats.totalEvents}*\nAggregates: *${stats.uniqueAggregates}*\nLast push: *${last}*`,
        )
      }
      await ack("ok")
      return
    }
    return ack("ok")
  }

  await ack("Azione sconosciuta", true)
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

  // Make sure this user is in the customers table. If they're brand new
  // (no row yet for either telegram_user_id or telegram handle), fire a
  // one-time admin notification with inline approve/reject buttons —
  // this used to never happen for Telegram-only signups, leaving the
  // dashboard's "Pending approvals" tab as the only way to see them.
  // Also: if the caller arrived via a /start ref_<CODE> deep-link, claim
  // the referral exactly once at create time.
  let _newSignup = false
  if (username || userId) {
    const existed = findCustomerByTelegram({ telegram: username, telegram_user_id: userId })
    const customer = findOrCreateCustomerByTelegram({ telegram: username, telegram_user_id: userId })
    if (!existed) {
      _newSignup = true
      const refCode = text.match(/^\/start\s+ref_([A-Z0-9]{4,32})\b/i)?.[1]
      if (refCode) {
        const r = claimReferral({ code: refCode, referredCustomerId: customer.id })
        if (r.ok) {
          log.info("referral claimed at signup", {
            customer: customer.id,
            referrer: r.referrer_customer_id,
          })
        } else {
          log.info("referral claim skipped", { reason: r.reason, code: refCode })
        }
      }
      void notifyAdminNewPendingUser({
        customer_id: customer.id,
        username: null,
        telegram: username ?? null,
        telegram_user_id: userId ?? null,
        email: customer.email,
        method: "telegram",
        created_at: customer.created_at,
      }).catch((err) =>
        log.warn("notifyAdminNewPendingUser failed", { error: err instanceof Error ? err.message : String(err) }),
      )
    }
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
      // Main menu — quick access to the most-used flows. Buttons fire
      // `menu:*` and `usr:*` callback patterns handled in
      // handleCallbackQuery. Layout adapts to whether the caller already
      // has an active license (in which case showing the order plans
      // first would be backwards).
      const me = findCustomerByTelegram({ telegram_user_id: userId })
      const lic = me ? getActiveLicenseForCustomer(me.id) : null
      const menu: TgKeyboard = lic
        ? [
            [{ text: "🎟️ My license", callback_data: "menu:mylicense" }],
            [
              { text: "📋 My orders", callback_data: "menu:myorders" },
              { text: "🔐 Devices", callback_data: "menu:devices" },
            ],
            [
              { text: "👥 Teams", callback_data: "menu:teams" },
              { text: "☁️ Sync", callback_data: "menu:sync" },
            ],
          ]
        : [
            [
              { text: "⚡ Monthly $20", callback_data: "menu:order:monthly" },
              { text: "🔥 Annual $200", callback_data: "menu:order:annual" },
            ],
            [{ text: "💎 Lifetime $500", callback_data: "menu:order:lifetime" }],
            [{ text: "📋 My orders", callback_data: "menu:myorders" }],
          ]
      await send(chatId, helpUser(lang) + (isAdmin ? "\n\n" + HELP_ADMIN : ""), "Markdown", menu)
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
      if (orders.length === 0) {
        await send(chatId, "You have no orders yet. Try `/order monthly`.", "Markdown", [
          [
            { text: "⚡ Monthly", callback_data: "menu:order:monthly" },
            { text: "🔥 Annual", callback_data: "menu:order:annual" },
            { text: "💎 Lifetime", callback_data: "menu:order:lifetime" },
          ],
        ])
        return
      }
      await send(chatId, `📋 *Your last orders* (${orders.length})`, "Markdown")
      for (const o of orders) {
        const created = new Date(o.created_at * 1000).toISOString().replace("T", " ").slice(0, 16)
        const body = `*${o.id}*\nPlan: *${o.interval}*\nStatus: *${o.status}*\nCreated: ${created} UTC`
        const kb: TgKeyboard | undefined =
          o.status === "pending" ? [[{ text: "🚫 Cancel order", callback_data: `usr:cancelmyord:${o.id}` }]] : undefined
        await send(chatId, body, "Markdown", kb)
      }
      return
    }

    case "referral":
    case "invite": {
      // /referral — show the calling user's shareable code + claim history.
      // The cap and reward amounts come from the central constant in
      // referrals.ts so the chat copy never drifts from the actual award.
      const customer = findCustomerByTelegram({ telegram_user_id: userId })
      if (!customer) {
        await send(chatId, "No CrimeCode account linked yet — open the desktop app first.")
        return
      }
      const row = getOrCreateReferralCode(customer.id)
      const claims = listReferralsByCustomer(customer.id, 50)
      const earned = claims.reduce((acc, c) => acc + c.referrer_bonus_days, 0)
      const body =
        "🎁 *Refer a friend* — earn extra trial days\n\n" +
        `Your code: \`${row.code}\`\n` +
        `Share link: https://crimecode.cc/r/${row.code}\n\n` +
        `Each new signup that uses your code:\n` +
        `• earns *you* +${REFERRAL_BONUS.referrer} days\n` +
        `• gives *them* +${REFERRAL_BONUS.referred} days bonus trial\n\n` +
        `Claims: *${claims.length}* — total earned: *${earned}* days\n` +
        `_(Cap: ${REFERRAL_BONUS.monthlyCap} bonus days per 30 rolling days.)_`
      await send(chatId, body, "Markdown")
      return
    }
    case "mylicense":
    case "license": {
      // Re-fetch the calling user's active license + activation token.
      // The customer is identified by telegram_user_id — same path the
      // /account/me/license HTTP endpoint uses, just exposed inside the
      // chat for users who lost their original token DM.
      const customer = findCustomerByTelegram({ telegram_user_id: userId })
      if (!customer) {
        await send(chatId, "No CrimeCode account linked to this Telegram. Open the desktop app to sign up.")
        return
      }
      const lic = getActiveLicenseForCustomer(customer.id)
      if (!lic) {
        await send(
          chatId,
          "📭 *No active license*\n\nYou don't have a paid or trial license yet. Pick a plan:",
          "Markdown",
          [
            [
              { text: "⚡ Monthly $20", callback_data: "menu:order:monthly" },
              { text: "🔥 Annual $200", callback_data: "menu:order:annual" },
            ],
            [{ text: "💎 Lifetime $500", callback_data: "menu:order:lifetime" }],
          ],
        )
        return
      }
      const { token } = makeToken({
        l: lic.id,
        i: lic.interval,
        t: lic.issued_at,
        ...(lic.expires_at != null ? { e: lic.expires_at } : {}),
      })
      const expLine = lic.expires_at
        ? `\nExpires: *${new Date(lic.expires_at * 1000).toISOString().slice(0, 10)}*`
        : "\nExpires: *never (lifetime)* 🎉"
      await send(
        chatId,
        `🎟️ *Your license*\n\nID: \`${lic.id}\`\nPlan: *${lic.interval}*${expLine}\n\n` +
          `Activation token (paste in the desktop app):\n\n\`${token}\`\n\n` +
          "_If you log in with the same Telegram on the desktop, the token is applied automatically — no copy-paste needed._",
        "Markdown",
      )
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
      await send(chatId, `🔐 *Active devices* (${active.length})`, "Markdown")
      for (const s of active) {
        const last = new Date(s.last_seen_at * 1000).toISOString().replace("T", " ").slice(0, 16)
        const id = s.id.length > 18 ? s.id.slice(0, 8) + "…" + s.id.slice(-6) : s.id
        const body =
          `*${escapeMd(s.device_label ?? "unknown device")}*\n` +
          `Session: \`${id}\`\n` +
          `Last seen: ${last} UTC`
        const kb: TgKeyboard = [[{ text: "🚪 Logout this device", callback_data: `usr:logoutdev:${s.id}` }]]
        await send(chatId, body, "Markdown", kb)
      }
      // Footer with the nuclear option.
      await send(chatId, "_Logout from every device at once:_", "Markdown", [
        [{ text: "🔌 Logout everywhere", callback_data: "usr:logoutall" }],
      ])
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
      await send(chatId, `📬 *Pending orders* (${orders.length})`, "Markdown")
      for (const o of orders) {
        const who = o.customer_telegram ? "@" + escapeMd(o.customer_telegram) : "_unknown_"
        const created = new Date(o.created_at * 1000).toISOString().replace("T", " ").slice(0, 16)
        const body = `*${o.id}*\nPlan: *${o.interval}*\nCustomer: ${who}\nCreated: ${created} UTC`
        const kb: TgKeyboard = [
          [
            { text: "✅ Confirm", callback_data: `adm:ordconf:${o.id}` },
            { text: "🚫 Cancel", callback_data: `adm:ordcancel:${o.id}` },
          ],
        ]
        await send(chatId, body, "Markdown", kb)
      }
      return
    }
    case "list": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const ls = listLicenses(20)
      if (ls.length === 0) { await send(chatId, "No licenses yet."); return }
      await send(chatId, `📜 *Last licenses* (${ls.length})`, "Markdown")
      for (const l of ls) {
        const status = l.revoked_at ? "🚫 *revoked*" : "✅ active"
        const who = l.customer_telegram ? "@" + escapeMd(l.customer_telegram) : `\`${l.customer_id}\``
        const issued = new Date(l.issued_at * 1000).toISOString().slice(0, 10)
        const body = `*${l.id}*\nPlan: *${l.interval}*\nCustomer: ${who}\nIssued: ${issued}\n${status}`
        const kb: TgKeyboard | undefined = l.revoked_at
          ? undefined
          : [[{ text: "🚫 Revoke", callback_data: `adm:licrevoke:${l.id}` }]]
        await send(chatId, body, "Markdown", kb)
      }
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
    // ── Pending-approval flow (Telegram-side admin tools) ──
    // The dashboard at /license/admin already exposes the same data
    // through HTML — these mirror it for admins who live in Telegram.
    case "pendingusers":
    case "pending_users": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const list = listPendingCustomers(50)
      if (list.length === 0) {
        await send(chatId, "✨ No pending users — the queue is empty.")
        return
      }
      // Render one message per pending user with inline approve/reject
      // buttons. Telegram caps the inline keyboard at ~100 buttons but
      // editing a single big message after each click is awkward — a
      // message-per-row keeps each click self-contained: the approved
      // row's message gets edited to "Approved by …", others stay live.
      await send(chatId, `⏳ *Pending approvals* (${list.length})`, "Markdown")
      for (const c of list) {
        const tg = c.telegram ? "@" + escapeMd(c.telegram) : "_no telegram_"
        const tgIdLine = c.telegram_user_id ? `\nTG: \`${c.telegram_user_id}\`` : ""
        const username = c.username ? `\nUser: \`${escapeMd(c.username)}\`` : ""
        const email = c.email ? `\nEmail: \`${escapeMd(c.email)}\`` : ""
        const when = new Date(c.created_at * 1000).toISOString().replace("T", " ").slice(0, 16)
        const body =
          `*${c.id}*\n` +
          `${tg}${tgIdLine}${username}${email}\n` +
          `Registered: ${when} UTC`
        const kb: TgKeyboard = [
          [
            { text: "✅ 2d", callback_data: `adm:approve:${c.id}:2` },
            { text: "🎁 7d", callback_data: `adm:approve:${c.id}:7` },
            { text: "❌ Reject", callback_data: `adm:reject:${c.id}` },
          ],
        ]
        await send(chatId, body, "Markdown", kb)
      }
      return
    }
    case "approve": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const parts = args.split(/\s+/).filter(Boolean)
      const id = parts[0]
      const days = Number.parseInt(parts[1] ?? "2", 10)
      if (!id) { await send(chatId, "Usage: `/approve <cus_id|@telegram|user_id> [days=2]`", "Markdown"); return }
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        await send(chatId, "Trial days must be a number between 1 and 365.")
        return
      }
      const customer = findCustomerByIdOrTelegram(id)
      if (!customer) { await send(chatId, "Customer not found."); return }
      const r = approveCustomer(customer.id, { trialDays: days, approvedBy: `tg:${userId}` })
      if (!r) { await send(chatId, "Approval failed — customer row vanished mid-flight."); return }
      // Best-effort DM the customer in their preferred language.
      void notifyUserApproved({ telegram_user_id: r.telegram_user_id, trial_days: days }).catch(() => undefined)
      await send(
        chatId,
        `✅ Approved \`${customer.id}\` with a *${days}-day* trial.${
          r.telegram_user_id ? "\n\nUser DM'd in their preferred language." : ""
        }`,
        "Markdown",
      )
      return
    }
    case "reject": {
      if (!isAdmin) { await send(chatId, "Not authorized."); return }
      const parts = args.split(/\s+/).filter(Boolean)
      const id = parts[0]
      const reason = parts.slice(1).join(" ").trim() || null
      if (!id) { await send(chatId, "Usage: `/reject <cus_id|@telegram|user_id> [reason]`", "Markdown"); return }
      const customer = findCustomerByIdOrTelegram(id)
      if (!customer) { await send(chatId, "Customer not found."); return }
      const r = rejectCustomer(customer.id, { reason, rejectedBy: `tg:${userId}` })
      if (!r) { await send(chatId, "Reject failed — customer row not found."); return }
      void notifyUserRejected({ telegram_user_id: r.telegram_user_id, reason }).catch(() => undefined)
      await send(
        chatId,
        `🚫 Rejected \`${customer.id}\`${reason ? `\nReason: _${escapeMd(reason)}_` : ""}`,
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
