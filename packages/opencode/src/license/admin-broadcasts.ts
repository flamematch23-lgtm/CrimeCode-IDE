/**
 * Admin broadcast push notifications.
 *
 * The operator picks a segment (e.g. "active_license") and types a
 * message; we fan-out via the Telegram bot to every telegram_user_id
 * in that segment, track delivered/failed counts, and persist the
 * outcome in admin_broadcasts so the dashboard can show a history.
 *
 * Why server-side fan-out (vs. doing it in Telegram itself):
 *   - Telegram has no "broadcast to a custom list" primitive — bots
 *     must DM each user individually
 *   - We need rate-limit handling (the bot API caps at 30 msg/sec
 *     globally) so we throttle here
 *   - Persisted history doubles as deliverability metrics and lets
 *     us dedupe operator double-sends
 *
 * Telegram delivery is best-effort: a user who has never started the
 * bot (`/start`) cannot receive DMs from it, which is logged as a
 * "failed" delivery with `Forbidden` in the error sample.
 */
import { Log } from "../util/log"
import { getDb } from "./db"

const log = Log.create({ service: "admin-broadcasts" })
const now = (): number => Math.floor(Date.now() / 1000)

export type BroadcastSegment =
  | "all"
  | "active_license"
  | "expired_license"
  | "pending_payment"
  | "trial"
  | "no_license"
  | "crypoverse_paid"
  | "team_owners"

export interface BroadcastRow {
  id: number
  segment: string
  message: string
  parse_mode: string | null
  sent_at: number
  sent_by: string
  total: number
  delivered: number
  failed: number
  error_sample: string | null
}

const SEGMENT_LABEL: Record<BroadcastSegment, string> = {
  all: "All customers with Telegram",
  active_license: "Customers with an active (non-revoked, non-expired) license",
  expired_license: "Customers whose license expired",
  pending_payment: "Customers with a pending order awaiting payment",
  trial: "Customers currently on trial (no paid license yet)",
  no_license: "Customers who never bought (no license ever)",
  crypoverse_paid: "Customers who have paid via Crypoverse at least once",
  team_owners: "Customers who own at least one team workspace",
}

/**
 * Resolve a segment to a list of distinct telegram_user_id rows. Always
 * filters out NULL telegram_user_id (bot can only DM users who have
 * started it). Returns the customer_id alongside so the dashboard can
 * surface "you reached @user".
 */
function resolveSegment(segment: BroadcastSegment): Array<{ customer_id: string; telegram_user_id: number }> {
  const db = getDb()
  const nowSec = now()
  const baseFilter = "c.telegram_user_id IS NOT NULL"
  const queries: Record<BroadcastSegment, { sql: string; params: unknown[] }> = {
    all: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c WHERE ${baseFilter}`,
      params: [],
    },
    active_license: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c JOIN licenses l ON l.customer_id = c.id
            WHERE ${baseFilter} AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)`,
      params: [nowSec],
    },
    expired_license: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c JOIN licenses l ON l.customer_id = c.id
            WHERE ${baseFilter} AND l.revoked_at IS NULL AND l.expires_at IS NOT NULL AND l.expires_at <= ?
              AND NOT EXISTS (SELECT 1 FROM licenses l2 WHERE l2.customer_id = c.id AND l2.revoked_at IS NULL AND (l2.expires_at IS NULL OR l2.expires_at > ?))`,
      params: [nowSec, nowSec],
    },
    pending_payment: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c JOIN orders o ON o.customer_user_id = c.telegram_user_id
            WHERE ${baseFilter} AND o.status = 'pending'`,
      params: [],
    },
    trial: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c
            WHERE ${baseFilter} AND c.approval_status = 'approved'
              AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.customer_id = c.id)`,
      params: [],
    },
    no_license: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c
            WHERE ${baseFilter}
              AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.customer_id = c.id)`,
      params: [],
    },
    crypoverse_paid: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c
            JOIN orders o ON o.customer_user_id = c.telegram_user_id
            JOIN crypoverse_invoices i ON i.order_id = o.id
            WHERE ${baseFilter} AND i.paid_at IS NOT NULL`,
      params: [],
    },
    team_owners: {
      sql: `SELECT DISTINCT c.id AS customer_id, c.telegram_user_id
            FROM customers c JOIN teams t ON t.owner_customer_id = c.id
            WHERE ${baseFilter}`,
      params: [],
    },
  }
  const q = queries[segment]
  type Params = Array<string | number>
  return db
    .prepare<{ customer_id: string; telegram_user_id: number }, Params>(q.sql)
    .all(...(q.params as Params))
}

export function segmentSize(segment: BroadcastSegment): number {
  return resolveSegment(segment).length
}

export function listSegmentSizes(): Array<{ segment: BroadcastSegment; label: string; count: number }> {
  return (Object.keys(SEGMENT_LABEL) as BroadcastSegment[]).map((s) => ({
    segment: s,
    label: SEGMENT_LABEL[s],
    count: segmentSize(s),
  }))
}

export function listBroadcasts(limit = 100): BroadcastRow[] {
  return getDb()
    .prepare<BroadcastRow, [number]>("SELECT * FROM admin_broadcasts ORDER BY sent_at DESC LIMIT ?")
    .all(limit)
}

/**
 * Fan-out broadcast. Throttles to ~25 msg/sec (Telegram's 30/sec cap
 * with safety margin). Returns the BroadcastRow once all deliveries
 * have been attempted. Errors are aggregated into `error_sample`
 * (truncated, first 5 distinct messages) for triage.
 */
export async function sendBroadcast(opts: {
  segment: BroadcastSegment
  message: string
  parse_mode?: "Markdown" | "HTML" | null
  sent_by: string
}): Promise<BroadcastRow> {
  const targets = resolveSegment(opts.segment)
  const sample: string[] = []
  let delivered = 0
  let failed = 0
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN not configured")
  log.info("broadcast starting", { segment: opts.segment, total: targets.length, sent_by: opts.sent_by })
  // Throttle to 25 msg/sec — 40ms gap between sends. Sequential to keep
  // the rate honest (a Promise.all storm would burst over the cap and
  // get the bot temporarily blocked). Fetch directly (vs. helper) so we
  // can read the response status and aggregate failure reasons.
  for (const t of targets) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: t.telegram_user_id,
          text: opts.message,
          parse_mode: opts.parse_mode ?? "Markdown",
          disable_web_page_preview: true,
        }),
      })
      if (resp.ok) {
        delivered++
      } else {
        failed++
        const body = await resp.text().catch(() => "")
        const msg = `HTTP ${resp.status} ${body.slice(0, 80)}`
        if (sample.length < 5 && !sample.includes(msg)) sample.push(msg)
      }
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      if (sample.length < 5 && !sample.includes(msg)) sample.push(msg)
    }
    await sleep(40)
  }
  const db = getDb()
  const result = db
    .prepare(
      `INSERT INTO admin_broadcasts
       (segment, message, parse_mode, sent_at, sent_by, total, delivered, failed, error_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.segment,
      opts.message,
      opts.parse_mode ?? null,
      now(),
      opts.sent_by,
      targets.length,
      delivered,
      failed,
      sample.length > 0 ? sample.join(" | ") : null,
    )
  log.info("broadcast finished", { segment: opts.segment, delivered, failed, total: targets.length })
  const id = Number(result.lastInsertRowid)
  return db.prepare<BroadcastRow, [number]>("SELECT * FROM admin_broadcasts WHERE id = ?").get(id)!
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
