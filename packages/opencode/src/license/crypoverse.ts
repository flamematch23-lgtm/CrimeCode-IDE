/**
 * Crypoverse hosted-gateway payment provider.
 *
 * Crypoverse is a non-custodial crypto checkout: we POST an invoice with an
 * amount in USD, redirect the user to a hosted pay page, and listen on an
 * SSE stream for status updates. When the gateway reports `paid` we flip
 * the linked order to `confirmed` and issue the license.
 *
 * Why SSE instead of the usual webhook POST? Crypoverse's design choice —
 * each invoice has its own short-lived stream at
 *   GET https://api.crypoverse.com/webhooks/transaction/<id>
 * We open one stream per pending invoice, hold the connection until the
 * gateway closes it (or status reaches a terminal state), and reconnect on
 * transport errors with exponential backoff.
 *
 * The on-chain provider (BTC/LTC/ETH self-hosted) keeps existing too — this
 * file is purely additive. A customer can pick either flow at checkout.
 *
 * Security note: Crypoverse does NOT sign the SSE payload (no HMAC). The
 * effective trust comes from (a) initiating the invoice ourselves so we
 * know its transaction_id, and (b) only ever calling confirmOrderAndIssue
 * for an invoice we created. Even if a third party guesses the (opaque,
 * UUID-ish) transaction_id and connects to its SSE stream, the worst they
 * achieve is observing payment status — they can't trigger license issuance
 * because the lookup goes invoice → order → customer and we re-check the
 * payload's `id` field against the row we created.
 */
import { getDb } from "./db"
import { getOrder } from "./store"
import { confirmOrderAndIssue, cancelOrder } from "./store"
import { newId } from "./token"
import { Log } from "../util/log"
import { captureException } from "./sentry"
import { sendCustomerTokenCrypoverse } from "./telegram-notify"
import { makeToken } from "./token"

const log = Log.create({ service: "license-crypoverse" })

// ── Config ─────────────────────────────────────────────────────────────
const API_BASE = process.env.CRYPOVERSE_API_URL ?? "https://api.crypoverse.com"
const PAY_BASE = process.env.CRYPOVERSE_PAY_URL ?? "https://crypoverse.com"
const API_KEY = process.env.CRYPOVERSE_API_KEY ?? ""
const FETCH_TIMEOUT_MS = 10_000

// SSE reconnect schedule. The gateway may close the stream after a few
// minutes of inactivity even for an open invoice — that's fine, we just
// reconnect. Capped at 60s so a misbehaving endpoint can't burn our quota.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]

// Terminal statuses — once we see one of these we stop listening. The exact
// strings are tolerant because the docs don't enumerate every value: we
// match case-insensitively on the prefix. Anything we don't recognise is
// treated as still-pending and persisted as-is for debugging.
const TERMINAL_PAID = ["paid", "confirmed", "completed", "succeeded"]
const TERMINAL_FAILED = ["expired", "cancelled", "canceled", "failed", "refunded"]

function isTerminalPaid(status: string): boolean {
  const s = status.toLowerCase()
  return TERMINAL_PAID.some((t) => s.includes(t))
}
function isTerminalFailed(status: string): boolean {
  const s = status.toLowerCase()
  return TERMINAL_FAILED.some((t) => s.includes(t))
}

// ── Pricing ───────────────────────────────────────────────────────────
// Single source of truth for plan → USD price. Mirrored on the marketing
// site (pricing.html) for display only; the server uses these numbers when
// initiating an invoice, so the user can never request a $0 license by
// tampering with the form. If you change a price here, also update
// pricing.html and home.html copy.
export const PLAN_PRICES_USD: Readonly<Record<"monthly" | "annual" | "lifetime", number>> = Object.freeze({
  monthly: 20,
  annual: 200,
  lifetime: 500,
})

// ── Types ──────────────────────────────────────────────────────────────
export interface CrypoverseInvoiceRow {
  id: string
  order_id: string
  transaction_id: string
  amount_usd: number
  status: string
  redirect_url: string
  last_event_at: number | null
  last_event_payload: string | null
  paid_at: number | null
  paid_tx_hash: string | null
  created_at: number
}

interface InitiateResponse {
  id: string
  status: string
  amountUsd: string | number
}

const now = (): number => Math.floor(Date.now() / 1000)

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create a Crypoverse invoice for an existing pending order. Returns the row
 * we just stored plus the redirect URL the client must open to complete the
 * payment. Also kicks off the SSE listener in the background — callers don't
 * need to await it.
 *
 * @throws if the API key is missing, the order doesn't exist, the API call
 *   fails, or the response is malformed.
 */
export async function initiateInvoice(opts: {
  orderId: string
  amountUsd: number
}): Promise<{ invoice: CrypoverseInvoiceRow; redirectUrl: string }> {
  if (!API_KEY) {
    throw new Error("CRYPOVERSE_API_KEY not configured")
  }
  if (!Number.isFinite(opts.amountUsd) || opts.amountUsd <= 0) {
    throw new Error(`invalid amountUsd: ${opts.amountUsd}`)
  }
  const order = getOrder(opts.orderId)
  if (!order) throw new Error(`order_not_found: ${opts.orderId}`)
  if (order.status !== "pending") throw new Error(`order_not_pending: ${order.status}`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}/transactions/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The /documentation page is incomplete — actual field names per
      // live API probe (each surfaced by a 400 from the previous attempt):
      //   - platformApiKey (body, not header)
      //   - transactionType: "default" | "pos"   (required)
      //   - currencyAmount: number               (required, NOT "amountUsd")
      //   - currencyCode: "USD"                  (required string, NOT "currency")
      // Verified end-to-end against api.crypoverse.com on 2026-05-16.
      body: JSON.stringify({
        platformApiKey: API_KEY,
        transactionType: "default",
        currencyAmount: opts.amountUsd,
        currencyCode: "USD",
      }),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`crypoverse initiate failed: HTTP ${resp.status} — ${text.slice(0, 200)}`)
  }
  const data = (await resp.json()) as InitiateResponse
  if (!data?.id || typeof data.id !== "string") {
    throw new Error(`crypoverse initiate returned no id: ${JSON.stringify(data).slice(0, 200)}`)
  }

  const redirectUrl = `${PAY_BASE}/transaction/${encodeURIComponent(data.id)}`
  const id = newId("cvi")
  const db = getDb()
  db.prepare(
    `INSERT INTO crypoverse_invoices
     (id, order_id, transaction_id, amount_usd, status, redirect_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.orderId, data.id, opts.amountUsd, data.status ?? "initiated", redirectUrl, now())
  log.info("invoice initiated", {
    invoice_id: id,
    order_id: opts.orderId,
    transaction_id: data.id,
    amount_usd: opts.amountUsd,
  })

  const invoice = getInvoiceById(id)!
  // Fire-and-forget: subscribeToInvoice handles its own retries + logging.
  void subscribeToInvoice(invoice.transaction_id).catch((err) => {
    log.error("subscriber crashed at startup", { transaction_id: invoice.transaction_id, error: String(err) })
    captureException(err, { tags: { context: "crypoverse.initiateInvoice.subscribe" } })
  })
  return { invoice, redirectUrl }
}

export function getInvoiceById(id: string): CrypoverseInvoiceRow | null {
  return (
    getDb()
      .prepare<CrypoverseInvoiceRow, [string]>("SELECT * FROM crypoverse_invoices WHERE id = ?")
      .get(id) ?? null
  )
}

export function getInvoiceByTransactionId(transactionId: string): CrypoverseInvoiceRow | null {
  return (
    getDb()
      .prepare<CrypoverseInvoiceRow, [string]>("SELECT * FROM crypoverse_invoices WHERE transaction_id = ?")
      .get(transactionId) ?? null
  )
}

export function listOpenInvoices(): CrypoverseInvoiceRow[] {
  return getDb()
    .prepare<CrypoverseInvoiceRow, []>(
      "SELECT * FROM crypoverse_invoices WHERE status NOT IN ('paid','confirmed','completed','succeeded','expired','cancelled','canceled','failed','refunded') ORDER BY created_at DESC",
    )
    .all()
}

// ── SSE listener ──────────────────────────────────────────────────────

// In-process registry so we don't start two listeners for the same invoice.
// Keyed by transaction_id. Each entry holds the AbortController so we can
// stop the listener on shutdown / when the invoice goes terminal.
const listeners = new Map<string, AbortController>()

/**
 * Open the SSE stream for one invoice and process events. Returns when the
 * invoice reaches a terminal status, when the listener is aborted via
 * stopAllListeners, or when retries are exhausted (only on auth errors —
 * transport errors retry indefinitely with backoff).
 *
 * Safe to call twice for the same transaction_id: the second call short-
 * circuits because of the registry check.
 */
export async function subscribeToInvoice(transactionId: string): Promise<void> {
  if (listeners.has(transactionId)) {
    log.debug("listener already running", { transaction_id: transactionId })
    return
  }
  const invoice = getInvoiceByTransactionId(transactionId)
  if (!invoice) {
    log.warn("subscribe called for unknown invoice", { transaction_id: transactionId })
    return
  }
  if (isTerminalPaid(invoice.status) || isTerminalFailed(invoice.status)) {
    log.debug("invoice already terminal — not subscribing", {
      transaction_id: transactionId,
      status: invoice.status,
    })
    return
  }
  const ctrl = new AbortController()
  listeners.set(transactionId, ctrl)
  try {
    await runListenerLoop(transactionId, ctrl.signal)
  } finally {
    listeners.delete(transactionId)
  }
}

async function runListenerLoop(transactionId: string, signal: AbortSignal): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    try {
      await openStream(transactionId, signal)
      // openStream returned cleanly — either reached terminal status (we
      // can stop) or the server closed without one. We re-check the row
      // and only reconnect if still non-terminal.
      const row = getInvoiceByTransactionId(transactionId)
      if (!row || isTerminalPaid(row.status) || isTerminalFailed(row.status)) return
      attempt = 0
      log.info("server closed stream without terminal status — reconnecting", { transaction_id: transactionId })
    } catch (err) {
      if (signal.aborted) return
      attempt++
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)]
      log.warn("stream error — backing off", {
        transaction_id: transactionId,
        attempt,
        delay_ms: delay,
        error: err instanceof Error ? err.message : String(err),
      })
      await sleep(delay, signal)
    }
  }
}

async function openStream(transactionId: string, signal: AbortSignal): Promise<void> {
  const url = `${API_BASE}/webhooks/transaction/${encodeURIComponent(transactionId)}`
  log.info("opening SSE stream", { url })
  const resp = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} on ${url}`)
  }
  if (!resp.body) {
    throw new Error("response body missing")
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buf = ""
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    // SSE events are separated by blank lines. We parse one event at a time.
    let sepIdx: number
    while ((sepIdx = buf.indexOf("\n\n")) !== -1 || (sepIdx = buf.indexOf("\r\n\r\n")) !== -1) {
      const rawEvent = buf.slice(0, sepIdx)
      buf = buf.slice(sepIdx + (buf[sepIdx + 1] === "\n" ? 2 : 4))
      const data = extractDataField(rawEvent)
      if (data) await handleEvent(transactionId, data)
    }
  }
}

function extractDataField(rawEvent: string): string | null {
  // SSE wire format:
  //   event: foo
  //   data: {"...}
  //   data: continued
  //   id: 42
  // We concatenate all `data:` lines (multi-line payloads are valid).
  const lines = rawEvent.split(/\r?\n/)
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  return dataLines.join("\n")
}

async function handleEvent(transactionId: string, rawData: string): Promise<void> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawData)
  } catch {
    log.warn("non-JSON SSE payload — ignoring", { transaction_id: transactionId, sample: rawData.slice(0, 120) })
    return
  }
  // Defensive: the gateway might echo the id under different keys
  // ("id", "transactionId", "transaction_id"). Accept whichever and
  // assert it matches the transaction we're listening to.
  const eventId =
    (typeof parsed.id === "string" && parsed.id) ||
    (typeof parsed.transactionId === "string" && parsed.transactionId) ||
    (typeof parsed.transaction_id === "string" && parsed.transaction_id) ||
    transactionId
  if (eventId !== transactionId) {
    log.warn("SSE payload id mismatch — possible cross-stream leak, dropping", {
      expected: transactionId,
      got: eventId,
    })
    return
  }
  const status = (typeof parsed.status === "string" && parsed.status) || "unknown"
  const txHash =
    (typeof parsed.tx_hash === "string" && parsed.tx_hash) ||
    (typeof parsed.txHash === "string" && parsed.txHash) ||
    (typeof parsed.hash === "string" && parsed.hash) ||
    null

  persistEvent(transactionId, status, rawData)

  if (isTerminalPaid(status)) {
    await onPaid(transactionId, txHash)
  } else if (isTerminalFailed(status)) {
    onFailed(transactionId, status)
  } else {
    log.debug("non-terminal SSE event", { transaction_id: transactionId, status })
  }
}

function persistEvent(transactionId: string, status: string, rawData: string): void {
  const db = getDb()
  db.prepare(
    `UPDATE crypoverse_invoices
     SET status = ?, last_event_at = ?, last_event_payload = ?
     WHERE transaction_id = ?
       AND status NOT IN ('paid','confirmed','completed','succeeded')`,
  ).run(status, now(), rawData.slice(0, 4000), transactionId)
}

async function onPaid(transactionId: string, txHash: string | null): Promise<void> {
  const db = getDb()
  const invoice = getInvoiceByTransactionId(transactionId)
  if (!invoice) {
    log.warn("onPaid for unknown invoice", { transaction_id: transactionId })
    return
  }
  // Idempotency: if we already issued the license, just log and stop.
  const order = getOrder(invoice.order_id)
  if (!order) {
    log.error("invoice references missing order", {
      transaction_id: transactionId,
      order_id: invoice.order_id,
    })
    return
  }
  if (order.status === "confirmed") {
    log.info("order already confirmed — nothing to do", { order_id: order.id })
    markPaid(transactionId, txHash)
    return
  }
  if (order.status === "cancelled") {
    log.warn("paid event arrived for cancelled order — flagging both", {
      order_id: order.id,
      transaction_id: transactionId,
    })
    markPaid(transactionId, txHash)
    return
  }
  const result = confirmOrderAndIssue({ order_id: invoice.order_id, tx_hash: txHash })
  if ("error" in result) {
    log.error("confirmOrderAndIssue failed", {
      order_id: invoice.order_id,
      transaction_id: transactionId,
      error: result.error,
    })
    captureException(new Error(`confirmOrderAndIssue: ${result.error}`), {
      tags: { context: "crypoverse.onPaid" },
      extra: { order_id: invoice.order_id },
    })
    return
  }
  markPaid(transactionId, txHash)
  log.info("license issued via Crypoverse", {
    order_id: invoice.order_id,
    transaction_id: transactionId,
    license_id: result.license.id,
    customer_id: result.customer.id,
    amount_usd: invoice.amount_usd,
  })
  // Push the license token to the user on Telegram, mirroring what the
  // on-chain poller does. Best-effort: we don't fail license issuance
  // just because Telegram is down — the user can always /token to
  // re-fetch it.
  if (result.customer.telegram_user_id != null) {
    const { token: licToken } = makeToken({
      l: result.license.id,
      i: result.license.interval,
      t: result.license.issued_at,
      ...(result.license.expires_at != null ? { e: result.license.expires_at } : {}),
    })
    void sendCustomerTokenCrypoverse({
      telegram_user_id: result.customer.telegram_user_id,
      license_id: result.license.id,
      interval: result.license.interval,
      expires_at: result.license.expires_at,
      token: licToken,
      amount_usd: invoice.amount_usd,
      tx_hash: txHash,
    }).catch((e) => log.warn("token DM failed", { error: String(e), customer_id: result.customer.id }))
  } else {
    log.info("paid customer has no telegram_user_id — license issued silently", {
      customer_id: result.customer.id,
      license_id: result.license.id,
    })
  }
  db.prepare("INSERT INTO audit (action, details, ts) VALUES (?, ?, ?)").run(
    "crypoverse.paid",
    JSON.stringify({
      invoice_id: invoice.id,
      order_id: invoice.order_id,
      transaction_id: transactionId,
      tx_hash: txHash,
      amount_usd: invoice.amount_usd,
      customer_id: result.customer.id,
      license_id: result.license.id,
    }),
    now(),
  )
}

function markPaid(transactionId: string, txHash: string | null): void {
  getDb()
    .prepare(
      "UPDATE crypoverse_invoices SET paid_at = ?, paid_tx_hash = ? WHERE transaction_id = ? AND paid_at IS NULL",
    )
    .run(now(), txHash, transactionId)
}

function onFailed(transactionId: string, status: string): void {
  const invoice = getInvoiceByTransactionId(transactionId)
  if (!invoice) return
  const order = getOrder(invoice.order_id)
  if (order && order.status === "pending") {
    cancelOrder(order.id)
    log.info("order cancelled due to Crypoverse terminal failure", {
      order_id: order.id,
      transaction_id: transactionId,
      status,
    })
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}

// ── Lifecycle ────────────────────────────────────────────────────────

/**
 * At server boot, re-attach a listener to every invoice that is still in
 * a non-terminal state. Without this, an invoice initiated before the
 * previous restart would never get its `paid` event picked up.
 */
export function startListenersForOpenInvoices(): void {
  if (!API_KEY) {
    log.info("CRYPOVERSE_API_KEY not set — provider disabled")
    return
  }
  const open = listOpenInvoices()
  log.info("re-attaching listeners for open invoices", { count: open.length })
  for (const inv of open) {
    void subscribeToInvoice(inv.transaction_id).catch((err) => {
      log.error("startListenersForOpenInvoices subscribe failed", {
        transaction_id: inv.transaction_id,
        error: String(err),
      })
    })
  }
}

/**
 * Abort every running listener. Called on graceful shutdown so we don't
 * leak open `fetch` connections / event loop handles.
 */
export function stopAllListeners(): void {
  for (const [tx, ctrl] of listeners) {
    ctrl.abort()
    log.debug("aborted listener", { transaction_id: tx })
  }
  listeners.clear()
}

/** Test helper — exported only for the test suite. */
export const __test = {
  isTerminalPaid,
  isTerminalFailed,
  extractDataField,
  handleEvent,
  persistEvent,
  listeners,
}
