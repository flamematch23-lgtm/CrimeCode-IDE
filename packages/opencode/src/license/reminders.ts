import { Log } from "../util/log"
import { getDb } from "./db"
import { recallLang, renewalReminderMessage } from "./telegram-i18n"

const log = Log.create({ service: "license-reminders" })

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6 hours
const WARN_DAYS_BEFORE = 7
const URGENT_DAYS_BEFORE = 1

let stopped = false
let timer: ReturnType<typeof setTimeout> | null = null

interface CandidateRow {
  id: string
  customer_id: string
  interval: string
  expires_at: number
  expiry_warning_sent_at: number | null
  telegram_user_id: number | null
}

async function sendReminderTo(
  userId: number,
  licenseId: string,
  interval: string,
  daysLeft: number,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  const urgent = daysLeft <= URGENT_DAYS_BEFORE
  const body = renewalReminderMessage(recallLang(userId), licenseId, interval, daysLeft, urgent)
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: body,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    })
  } catch (err) {
    log.warn("sendReminder failed", { user: userId, error: err instanceof Error ? err.message : String(err) })
  }
}

async function checkOnce(): Promise<void> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const future = now + WARN_DAYS_BEFORE * 86_400

  // Pick licenses that:
  //   - are still active (not revoked, not lifetime)
  //   - are within the warn window (expires in [now, now+7d])
  //   - have NOT been warned for this expiry cycle yet
  // The "for this expiry cycle" check is: expiry_warning_sent_at is older
  // than the current expiry minus the warn window (i.e. before this cycle
  // started). This makes the column survive renewals — a fresh expires_at
  // resets the "have we warned" answer.
  const rows = db
    .prepare<CandidateRow, [number, number]>(
      `SELECT l.id, l.customer_id, l.interval, l.expires_at, l.expiry_warning_sent_at,
              c.telegram_user_id
         FROM licenses l
         JOIN customers c ON c.id = l.customer_id
        WHERE l.revoked_at IS NULL
          AND l.expires_at IS NOT NULL
          AND l.expires_at > ?
          AND l.expires_at <= ?
          AND (l.expiry_warning_sent_at IS NULL
               OR l.expiry_warning_sent_at < l.expires_at - ${WARN_DAYS_BEFORE * 86_400})`,
    )
    .all(now, future)

  if (rows.length === 0) return
  log.info("renewal reminder candidates", { n: rows.length })

  for (const row of rows) {
    if (!row.telegram_user_id) continue
    const days = Math.max(1, Math.ceil((row.expires_at - now) / 86_400))
    await sendReminderTo(row.telegram_user_id, row.id, row.interval, days)
    db.prepare("UPDATE licenses SET expiry_warning_sent_at = ? WHERE id = ?").run(now, row.id)
  }
}

export function startRenewalReminders(): void {
  if (timer) return
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    log.info("TELEGRAM_BOT_TOKEN not set — renewal reminders disabled")
    return
  }
  log.info("starting renewal reminders", { interval_hours: CHECK_INTERVAL_MS / 3_600_000, warn_days: WARN_DAYS_BEFORE })
  const tick = async () => {
    if (stopped) return
    try {
      await checkOnce()
    } catch (err) {
      log.warn("checkOnce error", { error: err instanceof Error ? err.message : String(err) })
    }
    timer = setTimeout(tick, CHECK_INTERVAL_MS)
  }
  // First check 60s after boot, then every 6h.
  timer = setTimeout(tick, 60_000)
}

export function stopRenewalReminders(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
