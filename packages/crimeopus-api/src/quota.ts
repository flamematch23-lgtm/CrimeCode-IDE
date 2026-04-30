/**
 * Monthly quota tracking with automatic period rollover + threshold
 * webhooks (80% warning, 100% blocked).
 *
 * Counters live in `quota_period (key_id, period, used_tokens, used_requests, ...)`.
 * The first request of every UTC month creates a fresh row; the previous
 * period stays in the DB so admins can build retention/usage dashboards.
 *
 * Per-period state machine:
 *
 *   ┌─ used < 80% ────┐
 *   │                 │
 *   ▼                 │
 *  fresh ─→ 80% ─→ 100% (blocked)
 *           │
 *           └─ webhook 'quota.warning'      (fires once)
 *                   ▼
 *                webhook 'quota.exceeded'   (fires once, BLOCKS further requests)
 */
import { getDb, currentPeriod, nextMonthResetAt } from "./db.ts"
import { emitWebhook } from "./webhooks.ts"
import type { AuthContext } from "./auth.ts"

interface QuotaRow {
  id: number
  key_id: number
  period: string
  used_tokens: number
  used_requests: number
  reset_at: number
  warned_80: number
  warned_100: number
}

/** Get-or-create the quota row for the current period. */
function ensureCurrentPeriodRow(keyId: number): QuotaRow {
  const db = getDb()
  const period = currentPeriod()
  let row = db
    .query<QuotaRow, [number, string]>(
      "SELECT * FROM quota_period WHERE key_id = ? AND period = ?",
    )
    .get(keyId, period)
  if (!row) {
    db.run(
      "INSERT INTO quota_period (key_id, period, reset_at) VALUES (?, ?, ?)",
      [keyId, period, nextMonthResetAt()],
    )
    row = db
      .query<QuotaRow, [number, string]>(
        "SELECT * FROM quota_period WHERE key_id = ? AND period = ?",
      )
      .get(keyId, period)!
  }
  return row
}

export type QuotaCheck =
  | { allowed: true; remainingTokens: number | null; remainingRequests: number | null; period: string }
  | { allowed: false; reason: "tokens_exhausted" | "requests_exhausted"; period: string }

/**
 * Pre-flight check: are there enough tokens/requests left? Should be called
 * right before forwarding to the upstream model — returns `allowed:false`
 * to short-circuit with an HTTP 429 / quota_exceeded.
 */
export function checkQuota(ctx: AuthContext): QuotaCheck {
  const row = ensureCurrentPeriodRow(ctx.keyId)
  if (ctx.monthlyTokenQuota !== null && row.used_tokens >= ctx.monthlyTokenQuota) {
    return { allowed: false, reason: "tokens_exhausted", period: row.period }
  }
  if (ctx.monthlyRequestQuota !== null && row.used_requests >= ctx.monthlyRequestQuota) {
    return { allowed: false, reason: "requests_exhausted", period: row.period }
  }
  return {
    allowed: true,
    remainingTokens: ctx.monthlyTokenQuota === null ? null : Math.max(0, ctx.monthlyTokenQuota - row.used_tokens),
    remainingRequests:
      ctx.monthlyRequestQuota === null ? null : Math.max(0, ctx.monthlyRequestQuota - row.used_requests),
    period: row.period,
  }
}

/**
 * Increment counters after a request finishes. Fires the 80% / 100%
 * webhooks at most once per period (idempotent via warned_* columns).
 *
 * Called from the response side of every billable endpoint with the
 * actual token usage from the upstream response.
 */
export function recordUsage(args: {
  ctx: AuthContext
  promptTokens: number
  completionTokens: number
}): void {
  const db = getDb()
  const tokens = (args.promptTokens || 0) + (args.completionTokens || 0)
  const row = ensureCurrentPeriodRow(args.ctx.keyId)

  db.run(
    "UPDATE quota_period SET used_tokens = used_tokens + ?, used_requests = used_requests + 1 WHERE id = ?",
    [tokens, row.id],
  )

  const refreshed = db
    .query<QuotaRow, [number]>("SELECT * FROM quota_period WHERE id = ?")
    .get(row.id)!

  // Threshold webhooks
  const tokenLimit = args.ctx.monthlyTokenQuota
  const reqLimit = args.ctx.monthlyRequestQuota

  const tokenPct = tokenLimit ? refreshed.used_tokens / tokenLimit : 0
  const reqPct = reqLimit ? refreshed.used_requests / reqLimit : 0
  const pct = Math.max(tokenPct, reqPct)

  if (pct >= 0.8 && !refreshed.warned_80) {
    db.run("UPDATE quota_period SET warned_80 = 1 WHERE id = ?", [refreshed.id])
    emitWebhook("quota.warning", {
      key_label: args.ctx.label,
      tenant_id: args.ctx.tenantId,
      period: refreshed.period,
      used_tokens: refreshed.used_tokens,
      used_requests: refreshed.used_requests,
      max_tokens: tokenLimit,
      max_requests: reqLimit,
      percent: Math.round(pct * 100),
    })
  }
  if (pct >= 1 && !refreshed.warned_100) {
    db.run("UPDATE quota_period SET warned_100 = 1 WHERE id = ?", [refreshed.id])
    emitWebhook("quota.exceeded", {
      key_label: args.ctx.label,
      tenant_id: args.ctx.tenantId,
      period: refreshed.period,
      used_tokens: refreshed.used_tokens,
      used_requests: refreshed.used_requests,
      max_tokens: tokenLimit,
      max_requests: reqLimit,
    })
  }
}

/** Manual reset — for admin "Reset quota" button. Returns the now-empty row. */
export function resetCurrentPeriod(keyId: number): void {
  const db = getDb()
  const period = currentPeriod()
  db.run(
    "UPDATE quota_period SET used_tokens=0, used_requests=0, warned_80=0, warned_100=0 WHERE key_id = ? AND period = ?",
    [keyId, period],
  )
}

/** Used by the admin dashboard. */
export function getQuotaStatus(keyId: number): {
  current: QuotaRow | null
  history: QuotaRow[]
} {
  const db = getDb()
  const period = currentPeriod()
  const current = db
    .query<QuotaRow, [number, string]>("SELECT * FROM quota_period WHERE key_id = ? AND period = ?")
    .get(keyId, period)
  const history = db
    .query<QuotaRow, [number]>(
      "SELECT * FROM quota_period WHERE key_id = ? ORDER BY period DESC LIMIT 12",
    )
    .all(keyId)
  return { current: current ?? null, history }
}
