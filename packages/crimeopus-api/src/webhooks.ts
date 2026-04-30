/**
 * Outbound webhook dispatcher.
 *
 * Subscriptions live in the `webhooks` table:
 *   { url, event ('*' or specific), secret, enabled }
 *
 * Events emitted by the rest of the codebase:
 *   quota.warning      (>=80% of monthly token/request quota)
 *   quota.exceeded     (>=100%, blocks further requests)
 *   upstream.error     (Ollama unreachable / 5xx)
 *   ratelimit.exceeded (token bucket empty)
 *   audio.error        (whisper bridge failed)
 *
 * Every emit is fire-and-forget — failure to deliver is logged in
 * `webhook_deliveries` but never throws back to the caller. We retry up
 * to 3 times with exponential backoff (1s/3s/10s) inside a detached
 * promise.
 *
 * Payload signature: when the webhook row has a `secret`, we send
 *   X-CrimeOpus-Signature: sha256=<hex(hmac(secret, body))>
 * matching the GitHub webhook convention so consumers can copy patterns.
 */
import { createHmac } from "node:crypto"
import { getDb } from "./db.ts"

interface WebhookRow {
  id: number
  url: string
  event: string
  secret: string | null
  enabled: number
}

export type WebhookEvent =
  | "quota.warning"
  | "quota.exceeded"
  | "upstream.error"
  | "ratelimit.exceeded"
  | "audio.error"
  | "key.created"
  | "key.disabled"

export function emitWebhook(event: WebhookEvent, payload: Record<string, unknown>): void {
  const db = getDb()
  const subs = db
    .query<WebhookRow, [string]>(
      "SELECT * FROM webhooks WHERE enabled = 1 AND (event = '*' OR event = ?)",
    )
    .all(event)
  if (subs.length === 0) return
  const body = JSON.stringify({ event, ts: Date.now(), data: payload })
  for (const sub of subs) {
    void deliver(sub, event, body)
  }
}

async function deliver(sub: WebhookRow, event: string, body: string, attempt = 1): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-CrimeOpus-Event": event,
    "X-CrimeOpus-Delivery": String(Date.now()) + "-" + attempt,
  }
  if (sub.secret) {
    const sig = createHmac("sha256", sub.secret).update(body).digest("hex")
    headers["X-CrimeOpus-Signature"] = `sha256=${sig}`
  }
  const startedAt = Date.now()
  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(8000),
    })
    const text = await res.text().catch(() => "")
    logDelivery(sub.id, event, res.status, attempt, text.slice(0, 500), null)
    if (!res.ok && attempt < 3) scheduleRetry(sub, event, body, attempt)
  } catch (e) {
    const err = (e as Error).message
    logDelivery(sub.id, event, null, attempt, null, err)
    if (attempt < 3) scheduleRetry(sub, event, body, attempt)
  }
  void startedAt
}

function scheduleRetry(sub: WebhookRow, event: string, body: string, attempt: number) {
  const delay = attempt === 1 ? 1000 : attempt === 2 ? 3000 : 10_000
  setTimeout(() => void deliver(sub, event, body, attempt + 1), delay)
}

function logDelivery(
  webhookId: number,
  event: string,
  status: number | null,
  attempt: number,
  responseExcerpt: string | null,
  error: string | null,
) {
  try {
    getDb().run(
      `INSERT INTO webhook_deliveries (webhook_id, ts, event, status, attempt, response_excerpt, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [webhookId, Date.now(), event, status, attempt, responseExcerpt, error],
    )
  } catch {
    /* logging is best-effort */
  }
}

// ─── Admin-facing helpers ───────────────────────────────────────────────

export function listWebhooks() {
  return getDb().query("SELECT id, url, event, enabled, created_at, description FROM webhooks ORDER BY id DESC").all()
}

export function createWebhook(args: { url: string; event?: string; secret?: string; description?: string }) {
  const db = getDb()
  const r = db.run(
    "INSERT INTO webhooks (url, event, secret, description, created_at) VALUES (?, ?, ?, ?, ?)",
    [args.url, args.event ?? "*", args.secret ?? null, args.description ?? null, Date.now()],
  )
  return Number(r.lastInsertRowid)
}

export function deleteWebhook(id: number) {
  getDb().run("DELETE FROM webhooks WHERE id = ?", [id])
}

export function toggleWebhook(id: number) {
  getDb().run("UPDATE webhooks SET enabled = 1 - enabled WHERE id = ?", [id])
}

export function recentDeliveries(limit = 50) {
  return getDb()
    .query(
      `SELECT d.id, d.ts, d.event, d.status, d.attempt, d.response_excerpt, d.error, w.url
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       ORDER BY d.id DESC LIMIT ?`,
    )
    .all(limit)
}
