import { getDb } from "./db"
import { expiryFor, makeToken, newId, type Interval } from "./token"
import type { Currency } from "./prices"

export interface CustomerRow {
  id: string
  email: string | null
  telegram: string | null
  telegram_user_id: number | null
  note: string | null
  created_at: number
  approval_status: "pending" | "approved" | "rejected"
  approved_at: number | null
  approved_by: string | null
  approved_trial_days: number | null
  rejected_reason: string | null
}

export interface OrderRow {
  id: string
  customer_telegram: string | null
  customer_user_id: number | null
  interval: Interval
  status: "pending" | "confirmed" | "cancelled"
  tx_hash: string | null
  note: string | null
  created_at: number
  confirmed_at: number | null
  license_id: string | null
}

export interface LicenseRow {
  id: string
  customer_id: string
  order_id: string | null
  token_sig: string
  interval: Interval
  issued_at: number
  expires_at: number | null
  revoked_at: number | null
  revoked_reason: string | null
  last_validated_at: number | null
  machine_id: string | null
}

const now = (): number => Math.floor(Date.now() / 1000)

function audit(action: string, details: unknown): void {
  const db = getDb()
  db.prepare("INSERT INTO audit (action, details, ts) VALUES (?, ?, ?)").run(
    action,
    JSON.stringify(details ?? null),
    now(),
  )
}

/**
 * Read-only counterpart of findOrCreateCustomerByTelegram. Returns the
 * existing row matching either `telegram_user_id` (preferred) or
 * `telegram` handle, or null. Used by the bot's deep-link handler so it
 * can detect a brand-new signup BEFORE the row is inserted, and only
 * then ping the admin with notifyAdminNewPendingUser. Without this
 * pre-check the bot has no way to tell "first contact" from "returning
 * user", so the admin would either be spammed on every /start or never
 * pinged at all (the latter was the v2.22.18 reality).
 */
export function findCustomerByTelegram(opts: {
  telegram?: string | null
  telegram_user_id?: number | null
}): CustomerRow | null {
  const db = getDb()
  if (opts.telegram_user_id != null) {
    const row = db
      .prepare<CustomerRow, [number]>("SELECT * FROM customers WHERE telegram_user_id = ? LIMIT 1")
      .get(opts.telegram_user_id)
    if (row) return row
  }
  if (opts.telegram) {
    const row = db
      .prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE telegram = ? LIMIT 1")
      .get(opts.telegram)
    if (row) return row
  }
  return null
}

export function findOrCreateCustomerByTelegram(opts: {
  telegram?: string | null
  telegram_user_id?: number | null
  email?: string | null
  note?: string | null
}): CustomerRow {
  const db = getDb()
  if (opts.telegram_user_id != null) {
    const existing = db
      .prepare<CustomerRow, [number]>("SELECT * FROM customers WHERE telegram_user_id = ? LIMIT 1")
      .get(opts.telegram_user_id)
    if (existing) return existing
  } else if (opts.telegram) {
    const existing = db
      .prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE telegram = ? LIMIT 1")
      .get(opts.telegram)
    if (existing) return existing
  }
  const id = newId("cus")
  // New customers coming in from the bot (or anywhere else that calls
  // this helper) land as 'pending'. The admin approves from the
  // Telegram notification or the admin panel before the trial starts
  // and a session token is issued. Existing customers are untouched.
  db.prepare(
    "INSERT INTO customers (id, email, telegram, telegram_user_id, note, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
  ).run(id, opts.email ?? null, opts.telegram ?? null, opts.telegram_user_id ?? null, opts.note ?? null, now())
  audit("customer.create", { id, telegram: opts.telegram, telegram_user_id: opts.telegram_user_id, approval_status: "pending" })
  return db.prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE id = ?").get(id)!
}

/**
 * Read-only lookup that accepts either a `cus_…` id, a Telegram handle
 * (with or without leading "@"), or a numeric Telegram user id passed as
 * a string. Returns null if nothing matches — never inserts. Used by the
 * Telegram bot's admin `/whois` command and similar tooling.
 */
export function findCustomerByIdOrTelegram(needle: string): CustomerRow | null {
  const db = getDb()
  const trimmed = needle.trim()
  if (!trimmed) return null
  // 1) Direct customer_id lookup. Tried first regardless of prefix because
  // session tokens encode the canonical id in `sub`, and we want this
  // helper to resolve them even if the id format ever drifts from the
  // historical `cus_…` shape.
  const byId = db.prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE id = ?").get(trimmed)
  if (byId) return byId
  // 2) numeric Telegram user id
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) {
    const r = db
      .prepare<CustomerRow, [number]>("SELECT * FROM customers WHERE telegram_user_id = ? LIMIT 1")
      .get(numeric)
    if (r) return r
  }
  // 3) Telegram handle (strip leading @ if present)
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  const byHandle = db
    .prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE lower(telegram) = lower(?) LIMIT 1")
    .get(handle)
  return byHandle ?? null
}

export function createOrder(opts: {
  customer_telegram?: string | null
  customer_user_id?: number | null
  interval: Interval
  note?: string | null
}): OrderRow {
  const db = getDb()
  const id = newId("ord")
  db.prepare(
    "INSERT INTO orders (id, customer_telegram, customer_user_id, interval, status, note, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
  ).run(id, opts.customer_telegram ?? null, opts.customer_user_id ?? null, opts.interval, opts.note ?? null, now())
  audit("order.create", { id, interval: opts.interval, telegram: opts.customer_telegram })
  return db.prepare<OrderRow, [string]>("SELECT * FROM orders WHERE id = ?").get(id)!
}

export function getOrder(id: string): OrderRow | null {
  return getDb().prepare<OrderRow, [string]>("SELECT * FROM orders WHERE id = ?").get(id) ?? null
}

export function listPendingOrders(limit = 50): OrderRow[] {
  return getDb()
    .prepare<OrderRow, [number]>("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?")
    .all(limit)
}

export function listOrdersForUser(user_id: number, limit = 20): OrderRow[] {
  return getDb()
    .prepare<OrderRow, [number, number]>(
      "SELECT * FROM orders WHERE customer_user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(user_id, limit)
}

export function cancelOrder(id: string): OrderRow | null {
  const db = getDb()
  const row = getOrder(id)
  if (!row || row.status !== "pending") return null
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id)
  audit("order.cancel", { id })
  return getOrder(id)
}

export interface ConfirmResult {
  order: OrderRow
  customer: CustomerRow
  license: LicenseRow
  token: string
}

export function confirmOrderAndIssue(opts: {
  order_id: string
  tx_hash?: string | null
}): ConfirmResult | { error: string } {
  const db = getDb()
  const order = getOrder(opts.order_id)
  if (!order) return { error: "order_not_found" }
  if (order.status === "confirmed" && order.license_id) {
    const license = db.prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE id = ?").get(order.license_id)
    const customer = db
      .prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE id = ?")
      .get(license?.customer_id ?? "")
    if (license && customer) {
      const { token } = makeToken({
        l: license.id,
        i: license.interval,
        t: license.issued_at,
        ...(license.expires_at != null ? { e: license.expires_at } : {}),
      })
      return { order, customer, license, token }
    }
    return { error: "license_state_inconsistent" }
  }
  if (order.status === "cancelled") return { error: "order_cancelled" }

  const customer = findOrCreateCustomerByTelegram({
    telegram: order.customer_telegram,
    telegram_user_id: order.customer_user_id,
  })
  const issuedAt = now()
  const expiresAt = expiryFor(order.interval, issuedAt)
  const licenseId = newId("lic")
  const { token, sig } = makeToken({
    l: licenseId,
    i: order.interval,
    t: issuedAt,
    ...(expiresAt != null ? { e: expiresAt } : {}),
  })

  db.transaction(() => {
    db.prepare(
      "INSERT INTO licenses (id, customer_id, order_id, token_sig, interval, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(licenseId, customer.id, order.id, sig, order.interval, issuedAt, expiresAt ?? null)
    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = ?, tx_hash = ?, license_id = ? WHERE id = ?").run(
      issuedAt,
      opts.tx_hash ?? null,
      licenseId,
      order.id,
    )
  })()

  audit("license.issue", { license_id: licenseId, customer_id: customer.id, order_id: order.id })
  const finalOrder = getOrder(order.id)!
  const license = db.prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE id = ?").get(licenseId)!
  return { order: finalOrder, customer, license, token }
}

export interface ValidateInput {
  token_sig: string
  machine_id?: string | null
}

export interface ValidateResult {
  status: "valid" | "expired" | "revoked" | "unknown"
  expires_at?: number | null
  revoked_reason?: string | null
}

export function validateBySig(input: ValidateInput): ValidateResult {
  const db = getDb()
  const lic = db
    .prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE token_sig = ?")
    .get(input.token_sig)
  if (!lic) return { status: "unknown" }
  if (lic.revoked_at) return { status: "revoked", revoked_reason: lic.revoked_reason ?? null }
  if (lic.expires_at != null && lic.expires_at <= now())
    return { status: "expired", expires_at: lic.expires_at }
  db.prepare("UPDATE licenses SET last_validated_at = ?, machine_id = COALESCE(?, machine_id) WHERE id = ?").run(
    now(),
    input.machine_id ?? null,
    lic.id,
  )
  audit("license.validate", { license_id: lic.id, machine_id: input.machine_id ?? null })
  return { status: "valid", expires_at: lic.expires_at }
}

export function revokeLicense(id: string, reason?: string | null): LicenseRow | null {
  const db = getDb()
  const lic = db.prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE id = ?").get(id)
  if (!lic) return null
  if (lic.revoked_at) return lic
  db.prepare("UPDATE licenses SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(now(), reason ?? null, id)
  audit("license.revoke", { license_id: id, reason })
  return db.prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE id = ?").get(id)!
}

export function listLicenses(limit = 100): Array<LicenseRow & { customer_telegram: string | null }> {
  return getDb()
    .prepare<LicenseRow & { customer_telegram: string | null }, [number]>(
      `SELECT l.*, c.telegram AS customer_telegram FROM licenses l
       LEFT JOIN customers c ON c.id = l.customer_id
       ORDER BY l.issued_at DESC LIMIT ?`,
    )
    .all(limit)
}

export function listAudit(limit = 100): Array<{ id: number; action: string; details: string | null; ts: number }> {
  return getDb()
    .prepare<{ id: number; action: string; details: string | null; ts: number }, [number]>(
      "SELECT * FROM audit ORDER BY id DESC LIMIT ?",
    )
    .all(limit)
}

/**
 * Return every license row for `customerId` (most-recently-issued first).
 * Used by /account/me/license + the bot's /mylicense command so a user
 * can see and re-fetch a token they already paid for. Includes revoked
 * rows so the UI can show "ended on YYYY-MM-DD" — filtering is the
 * caller's responsibility.
 */
export function listLicensesForCustomer(customerId: string): LicenseRow[] {
  return getDb()
    .prepare<LicenseRow, [string]>(
      "SELECT * FROM licenses WHERE customer_id = ? ORDER BY issued_at DESC",
    )
    .all(customerId)
}

/**
 * Convenience: pick the single "currently usable" license for a customer.
 * Returns the most-recently-issued non-revoked, non-expired row, or null
 * if there isn't one. The token isn't included — call makeToken() at
 * the call site to regenerate it from the row (the signature in the DB
 * is deterministic, so the same payload always produces the same JWT).
 */
export function getActiveLicenseForCustomer(customerId: string): LicenseRow | null {
  const nowSec = now()
  const row = getDb()
    .prepare<LicenseRow, [string, number]>(
      `SELECT * FROM licenses
        WHERE customer_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY issued_at DESC LIMIT 1`,
    )
    .get(customerId, nowSec)
  return row ?? null
}

export function getLicense(id: string): LicenseRow | null {
  return getDb().prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE id = ?").get(id) ?? null
}

export interface PaymentOfferRow {
  id: string
  order_id: string
  currency: Currency
  expected_units: string // BigInt as text
  wallet_address: string
  expires_at: number
  matched_tx_hash: string | null
  matched_at: number | null
  created_at: number
}

export function attachPaymentOffer(opts: {
  order_id: string
  currency: Currency
  expected_units: bigint
  wallet_address: string
  expires_at: number
}): PaymentOfferRow {
  const db = getDb()
  const id = newId("po")
  db.prepare(
    "INSERT INTO payment_offers (id, order_id, currency, expected_units, wallet_address, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, opts.order_id, opts.currency, opts.expected_units.toString(), opts.wallet_address, opts.expires_at, now())
  audit("payment.offer", { id, order_id: opts.order_id, currency: opts.currency, units: opts.expected_units.toString() })
  return db.prepare<PaymentOfferRow, [string]>("SELECT * FROM payment_offers WHERE id = ?").get(id)!
}

export function listOpenOffersForWallet(currency: Currency, wallet: string): PaymentOfferRow[] {
  return getDb()
    .prepare<PaymentOfferRow, [string, string, number]>(
      `SELECT * FROM payment_offers
       WHERE currency = ? AND wallet_address = ?
         AND matched_tx_hash IS NULL
         AND expires_at > ?
       ORDER BY created_at ASC`,
    )
    .all(currency, wallet, now())
}

export function markOfferMatched(id: string, txHash: string): void {
  getDb()
    .prepare("UPDATE payment_offers SET matched_tx_hash = ?, matched_at = ? WHERE id = ? AND matched_tx_hash IS NULL")
    .run(txHash, now(), id)
  audit("payment.match", { offer_id: id, tx_hash: txHash })
}

export function getOffersForOrder(orderId: string): PaymentOfferRow[] {
  return getDb()
    .prepare<PaymentOfferRow, [string]>("SELECT * FROM payment_offers WHERE order_id = ? ORDER BY currency")
    .all(orderId)
}

export function listOpenOffers(limit = 200): PaymentOfferRow[] {
  return getDb()
    .prepare<PaymentOfferRow, [number, number]>(
      `SELECT * FROM payment_offers
       WHERE matched_tx_hash IS NULL AND expires_at > ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(now(), limit)
}

/**
 * Issue or extend a "server-side trial" license for a customer: a real
 * license token with a short expiry and no payment. Used by the web admin
 * dashboard to hand out extensions / promos.
 */
export function adminExtendTrial(opts: {
  customer_telegram?: string | null
  days: number
  note?: string | null
}): { customer: CustomerRow; license: LicenseRow; token: string } {
  if (!opts.customer_telegram) throw new Error("missing_customer_telegram")
  if (!Number.isFinite(opts.days) || opts.days <= 0 || opts.days > 365) throw new Error("bad_days")
  const db = getDb()
  const customer = findOrCreateCustomerByTelegram({
    telegram: opts.customer_telegram,
    note: opts.note ?? null,
  })
  const issuedAt = now()
  const expiresAt = issuedAt + opts.days * 86400
  const licenseId = newId("lic")
  const { token, sig } = makeToken({
    l: licenseId,
    i: "monthly",
    t: issuedAt,
    e: expiresAt,
  })
  db.prepare(
    "INSERT INTO licenses (id, customer_id, order_id, token_sig, interval, issued_at, expires_at) VALUES (?, ?, NULL, ?, 'monthly', ?, ?)",
  ).run(licenseId, customer.id, sig, issuedAt, expiresAt)
  audit("license.admin_trial", { license_id: licenseId, customer_id: customer.id, days: opts.days, note: opts.note ?? null })
  const license = db.prepare<LicenseRow, [string]>("SELECT * FROM licenses WHERE id = ?").get(licenseId)!
  return { customer, license, token }
}

/**
 * Revenue / conversion / churn counters used by the admin analytics panel.
 * All computed from the existing orders + licenses tables — no extra state.
 */
export function analyticsSnapshot(): {
  revenue_30d_usd: number
  revenue_365d_usd: number
  revenue_total_usd: number
  orders_30d: number
  orders_total: number
  orders_pending: number
  licenses_active: number
  licenses_expired: number
  licenses_revoked: number
  mrr_usd: number
  conversion_rate_pct: number
  churn_30d_pct: number
} {
  const db = getDb()
  const nowSec = now()
  const priceByInterval: Record<string, number> = { monthly: 20, annual: 200, lifetime: 500 }
  const sumRevenue = (sinceSec?: number): number => {
    const q = sinceSec
      ? "SELECT interval, COUNT(*) AS n FROM orders WHERE status = 'confirmed' AND confirmed_at >= ? GROUP BY interval"
      : "SELECT interval, COUNT(*) AS n FROM orders WHERE status = 'confirmed' GROUP BY interval"
    const rows = sinceSec
      ? db.prepare<{ interval: string; n: number }, [number]>(q).all(sinceSec)
      : db.prepare<{ interval: string; n: number }, []>(q).all()
    return rows.reduce((sum, r) => sum + (priceByInterval[r.interval] ?? 0) * r.n, 0)
  }
  const revenue_30d_usd = sumRevenue(nowSec - 30 * 86400)
  const revenue_365d_usd = sumRevenue(nowSec - 365 * 86400)
  const revenue_total_usd = sumRevenue()

  const orders_30d =
    db
      .prepare<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed' AND confirmed_at >= ?",
      )
      .get(nowSec - 30 * 86400)?.n ?? 0
  const orders_total = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed'").get()?.n ?? 0
  const orders_pending = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get()?.n ?? 0

  const licenses_active =
    db
      .prepare<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(nowSec)?.n ?? 0
  const licenses_expired =
    db
      .prepare<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .get(nowSec)?.n ?? 0
  const licenses_revoked = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NOT NULL").get()?.n ?? 0

  // MRR approximation: sum of active monthly ($20) + active annual / 12 ($16.67). Lifetime doesn't contribute to MRR.
  const monthly_active =
    db
      .prepare<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM licenses WHERE interval = 'monthly' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(nowSec)?.n ?? 0
  const annual_active =
    db
      .prepare<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM licenses WHERE interval = 'annual' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(nowSec)?.n ?? 0
  const mrr_usd = monthly_active * 20 + annual_active * (200 / 12)

  // Conversion rate: confirmed orders / total orders (pending + cancelled + confirmed) over all time.
  const total_orders_everywhere = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders").get()?.n ?? 0
  const conversion_rate_pct = total_orders_everywhere > 0 ? (orders_total / total_orders_everywhere) * 100 : 0

  // Churn: licenses expired or revoked in the last 30 days / active 30 days ago.
  const expired_30d =
    db
      .prepare<{ n: number }, [number, number]>(
        "SELECT COUNT(*) AS n FROM licenses WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?",
      )
      .get(nowSec - 30 * 86400, nowSec)?.n ?? 0
  const revoked_30d =
    db
      .prepare<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM licenses WHERE revoked_at >= ?")
      .get(nowSec - 30 * 86400)?.n ?? 0
  const active_30d_ago = licenses_active + expired_30d + revoked_30d
  const churn_30d_pct = active_30d_ago > 0 ? ((expired_30d + revoked_30d) / active_30d_ago) * 100 : 0

  return {
    revenue_30d_usd,
    revenue_365d_usd,
    revenue_total_usd,
    orders_30d,
    orders_total,
    orders_pending,
    licenses_active,
    licenses_expired,
    licenses_revoked,
    mrr_usd: Math.round(mrr_usd * 100) / 100,
    conversion_rate_pct: Math.round(conversion_rate_pct * 10) / 10,
    churn_30d_pct: Math.round(churn_30d_pct * 10) / 10,
  }
}

export function statsCounts(): {
  customers: number
  orders_pending: number
  orders_confirmed: number
  licenses_active: number
  licenses_revoked: number
} {
  const db = getDb()
  const row = (q: string) => db.prepare<{ n: number }, []>(q).get()?.n ?? 0
  return {
    customers: row("SELECT COUNT(*) AS n FROM customers"),
    orders_pending: row("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"),
    orders_confirmed: row("SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed'"),
    licenses_active: row(
      `SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > strftime('%s','now'))`,
    ),
    licenses_revoked: row("SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NOT NULL"),
  }
}
