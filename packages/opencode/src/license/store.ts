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
  db.prepare(
    "INSERT INTO customers (id, email, telegram, telegram_user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, opts.email ?? null, opts.telegram ?? null, opts.telegram_user_id ?? null, opts.note ?? null, now())
  audit("customer.create", { id, telegram: opts.telegram, telegram_user_id: opts.telegram_user_id })
  return db.prepare<CustomerRow, [string]>("SELECT * FROM customers WHERE id = ?").get(id)!
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
