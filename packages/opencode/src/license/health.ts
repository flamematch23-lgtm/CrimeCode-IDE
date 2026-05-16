/**
 * System health snapshot for the admin dashboard.
 *
 * Pulls together:
 *   - process metrics (uptime, RSS memory, heap, node version, pid)
 *   - SQLite stats (DB file size, page count, wal mode, last backup)
 *   - background worker status (payment poller, crypoverse listeners,
 *     team reaper, backup scheduler)
 *   - environment flags (which optional services are enabled — telegram,
 *     crypoverse, S3 backup, sentry)
 *   - recent errors from the audit log
 *
 * Designed to fail-soft — any unreachable subsystem returns null/false
 * for its section rather than throwing.
 */
import { getDb } from "./db"
import { getLastBackupInfo } from "./backup"
import { getListenerCount } from "./crypoverse"

const startedAt = Math.floor(Date.now() / 1000)

interface DbStats {
  file_size_bytes: number
  page_count: number
  page_size: number
  journal_mode: string
  customers: number
  orders: number
  licenses: number
  audit_rows: number
}

function dbStats(): DbStats | null {
  try {
    const db = getDb()
    const pragma = <T>(name: string) =>
      db.prepare<T, []>(`PRAGMA ${name}`).get() as T | undefined
    const pageCount = pragma<{ page_count: number }>("page_count")?.page_count ?? 0
    const pageSize = pragma<{ page_size: number }>("page_size")?.page_size ?? 0
    const journalMode = pragma<{ journal_mode: string }>("journal_mode")?.journal_mode ?? "?"
    const count = (table: string): number =>
      (db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
    return {
      file_size_bytes: pageCount * pageSize,
      page_count: pageCount,
      page_size: pageSize,
      journal_mode: journalMode,
      customers: count("customers"),
      orders: count("orders"),
      licenses: count("licenses"),
      audit_rows: count("audit"),
    }
  } catch {
    return null
  }
}

function envFlags() {
  return {
    telegram_bot: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    telegram_admin_ids: Boolean(process.env.TELEGRAM_ADMIN_USER_IDS || process.env.OPENCODE_ADMIN_CHAT_ID),
    crypoverse: Boolean(process.env.CRYPOVERSE_API_KEY),
    s3_backup: Boolean(
      process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || process.env.LICENSE_BACKUP_BUCKET,
    ),
    sentry: Boolean(process.env.SENTRY_DSN),
    on_chain_wallets:
      Boolean(process.env.BTC_WALLET_ADDRESS) ||
      Boolean(process.env.LTC_WALLET_ADDRESS) ||
      Boolean(process.env.ETH_WALLET_ADDRESS),
    license_hmac: Boolean(process.env.LICENSE_HMAC_SECRET),
    admin_password: Boolean(process.env.ADMIN_PASSWORD),
  }
}

function recentErrors(limit = 20): Array<{ ts: number; action: string; details: string | null }> {
  try {
    const db = getDb()
    return db
      .prepare<{ ts: number; action: string; details: string | null }, [number]>(
        // We treat any audit row whose action ends in `.error` or whose
        // details contain `"error"` as a failure event. Cheap heuristic
        // that works because the audit table is small and the dashboard
        // only asks for the last 20 rows.
        `SELECT ts, action, details FROM audit
         WHERE action LIKE '%.error' OR action LIKE '%.fail%' OR details LIKE '%"error"%'
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit)
  } catch {
    return []
  }
}

export function getSystemHealth(): {
  process: {
    uptime_seconds: number
    rss_bytes: number
    heap_used_bytes: number
    heap_total_bytes: number
    pid: number
    node_version: string
    bun_version: string | null
    started_at: number
  }
  db: DbStats | null
  workers: {
    payment_poller_enabled: boolean
    crypoverse_enabled: boolean
    crypoverse_listeners_active: number
    backup_scheduler_enabled: boolean
    last_backup: ReturnType<typeof getLastBackupInfo>
  }
  env: ReturnType<typeof envFlags>
  recent_errors: Array<{ ts: number; action: string; details: string | null }>
} {
  const mem = process.memoryUsage()
  const env = envFlags()
  return {
    process: {
      uptime_seconds: Math.floor(Date.now() / 1000) - startedAt,
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      pid: process.pid,
      node_version: process.version,
      bun_version: (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
      started_at: startedAt,
    },
    db: dbStats(),
    workers: {
      payment_poller_enabled: env.on_chain_wallets,
      crypoverse_enabled: env.crypoverse,
      crypoverse_listeners_active: getListenerCount(),
      backup_scheduler_enabled: env.s3_backup,
      last_backup: getLastBackupInfo(),
    },
    env,
    recent_errors: recentErrors(20),
  }
}
