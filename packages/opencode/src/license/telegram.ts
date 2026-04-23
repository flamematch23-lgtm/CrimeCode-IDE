import { Log } from "../util/log"
import {
  cancelOrder,
  confirmOrderAndIssue,
  createOrder,
  findOrCreateCustomerByTelegram,
  getLicense,
  getOrder,
  listOrdersForUser,
  listLicenses,
  listPendingOrders,
  revokeLicense,
  statsCounts,
} from "./store"
import { verifyToken } from "./token"

const log = Log.create({ service: "telegram-bot" })

const POLL_INTERVAL_MS = 30_000
const POLL_TIMEOUT_S = 25

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string; first_name?: string }
    chat: { id: number }
    text?: string
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

The IDE for fraud researchers and security professionals — built by the team, for the team.

📋 *How to subscribe (3 simple steps)*

*1.* Pick your plan with \`/order\`
   • \`/order monthly\` — €X / month
   • \`/order annual\` — €X / year (save ~30%)
   • \`/order lifetime\` — €X one-time, forever

*2.* Pay one of our wallets (USDT, BTC, ETH, Monero accepted):
   👉 Contact @OpCrime1312 or @JollyFraud with your order ID — they'll give you the wallet address and confirm receipt.

*3.* Receive your license token here automatically as soon as the payment is verified. Paste it into the desktop app → Subscription gate → "I have a token" → Activate. Done.

📌 *Useful commands*
\`/start\` — show this message
\`/order monthly|annual|lifetime\` — create a new order
\`/status <order_id>\` — check the status of one of your orders
\`/myorders\` — list your last orders

🔒 *Privacy*
We only store: your Telegram handle, your order, the issued license token signature. No emails, no payment data, no personal IDs unless you give them to us.

🆘 *Need help?* Reply to this chat or message @OpCrime1312 directly.`

const HELP_ADMIN = `🛠️ *Admin commands* (you only)

\`/confirm <order_id> [tx_hash]\` — confirm payment + auto-deliver token
\`/cancel <order_id>\` — cancel a pending order
\`/pending\` — list pending orders
\`/list\` — last 20 licenses
\`/revoke <license_id> [reason]\` — revoke a license
\`/lookup <token>\` — find license by token
\`/stats\` — counters dashboard

Dashboard web: \`https://api.crimecode.cc/license/admin\``

function newOrderMessage(orderId: string, interval: string): string {
  return `✅ *Order created!*

ID: \`${orderId}\`
Plan: *${interval}*
Status: *pending payment*

📨 *Next step* — contact one of:
   • @OpCrime1312
   • @JollyFraud

Send them this order ID along with your preferred payment method (USDT / BTC / ETH / XMR). They'll reply with the wallet address.

As soon as the payment lands, you'll receive your license token *here automatically*. ⚡

Use \`/status ${orderId}\` to check the status anytime.`
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

async function handle(update: TgUpdate) {
  const msg = update.message
  if (!msg || !msg.text || !msg.from) return
  const chatId = msg.chat.id
  const userId = msg.from.id
  const username = msg.from.username ? `@${msg.from.username}` : null
  const text = msg.text.trim()
  const isAdmin = getAdminUserIds().has(userId)

  log.info("telegram message", { from: userId, username, text: text.slice(0, 80) })

  const cmdMatch = text.match(/^\/([a-zA-Z]+)(?:@\w+)?(?:\s+(.*))?$/)
  if (!cmdMatch) {
    await send(chatId, HELP_USER, "Markdown")
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
    case "help":
      await send(chatId, HELP_USER + (isAdmin ? "\n\n" + HELP_ADMIN : ""), "Markdown")
      return
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
      await send(chatId, newOrderMessage(o.id, o.interval), "Markdown")
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
    case "myorders": {
      const orders = listOrdersForUser(userId, 10)
      if (orders.length === 0) { await send(chatId, "You have no orders yet. Try `/order monthly`.", "Markdown"); return }
      const lines = orders.map((o) => `• \`${o.id}\` — ${o.interval} — *${o.status}*`)
      await send(chatId, "Your last orders:\n" + lines.join("\n"), "Markdown")
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
      // notify customer
      if (r.customer.telegram_user_id) {
        await send(
          r.customer.telegram_user_id,
          tokenDeliveryMessage(r.license.id, r.license.interval, r.license.expires_at, r.token),
          "Markdown",
        )
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
    default:
      await send(chatId, HELP_USER + (isAdmin ? "\n\n" + HELP_ADMIN : ""), "Markdown")
  }
}

async function pollOnce(token: string) {
  const r = await tgFetch<TgUpdate[]>(token, "getUpdates", {
    offset: lastUpdateId + 1,
    timeout: POLL_TIMEOUT_S,
    allowed_updates: ["message"],
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
