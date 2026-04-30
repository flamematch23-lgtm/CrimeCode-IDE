import type { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { userAuth } from "../middleware/user-auth.ts"
import { DASHBOARD_HTML } from "../dashboard-html.ts"
import { makeCsrfToken, verifyCsrfToken } from "../csrf.ts"
import { verifyTokenCrypto } from "../license-auth.ts"

const DEFAULT_RPM = 60
const DEFAULT_MONTHLY_TOKEN_QUOTA = 1_000_000
const DEFAULT_MONTHLY_REQUEST_QUOTA = 10_000

function generateKey(): string {
  return `sk-${randomBytes(20).toString("hex")}`
}

function previewKey(secret: string): string {
  return `${secret.slice(0, 9)}...${secret.slice(-3)}`
}

export type UserRoutesDeps = {
  licenseDb: Database
  usageDb: Database
}

export function mountUserRoutes(app: Hono, deps: UserRoutesDeps) {
  const auth = userAuth({ licenseDb: deps.licenseDb })

  // ─── GET /dashboard (public — SPA decides login vs app) ───────
  app.get("/dashboard", (c) => {
    let csrf = ""
    const cookie = c.req.header("Cookie") ?? ""
    const m = /crimeopus_session=([^;]+)/.exec(cookie)
    if (m) {
      const v = verifyTokenCrypto(m[1])
      if (v.ok) csrf = makeCsrfToken(v.payload.sid, process.env.LICENSE_HMAC_SECRET ?? "")
    }
    const html = DASHBOARD_HTML.replace("{{CSRF_TOKEN}}", csrf)
    return c.html(html)
  })

  // ─── GET /api/user/me ─────────────────────────────────────────
  app.get("/api/user/me", auth, (c) => {
    const cust = c.get("customer")
    return c.json({
      id: cust.id,
      email: cust.email,
      telegram: cust.telegram,
      telegram_user_id: cust.telegram_user_id,
      approval_status: cust.approval_status,
    })
  })

  // ─── GET /api/user/keys ───────────────────────────────────────
  app.get("/api/user/keys", auth, (c) => {
    const cust = c.get("customer")
    let rows = deps.usageDb
      .query(
        `SELECT id, label, secret, rpm, monthly_token_quota, monthly_request_quota, created_at
         FROM keys
         WHERE tenant_id = ? AND kind = 'static' AND disabled = 0
         ORDER BY id ASC`,
      )
      .all(cust.id) as Array<{
      id: number
      label: string
      secret: string
      rpm: number
      monthly_token_quota: number
      monthly_request_quota: number
      created_at: number
    }>

    if (rows.length === 0) {
      // Auto-create one key on first dashboard visit.
      const secret = generateKey()
      const label = `dash_${cust.id}_${Date.now()}`
      const result = deps.usageDb.run(
        `INSERT INTO keys (kind, label, secret, tenant_id, rpm, monthly_token_quota, monthly_request_quota, scopes, disabled, created_at, notes)
         VALUES ('static', ?, ?, ?, ?, ?, ?, '*', 0, ?, ?)`,
        label,
        secret,
        cust.id,
        DEFAULT_RPM,
        DEFAULT_MONTHLY_TOKEN_QUOTA,
        DEFAULT_MONTHLY_REQUEST_QUOTA,
        Date.now(),
        "auto-created on first dashboard login",
      )
      rows = [
        {
          id: Number(result.lastInsertRowid),
          label,
          secret,
          rpm: DEFAULT_RPM,
          monthly_token_quota: DEFAULT_MONTHLY_TOKEN_QUOTA,
          monthly_request_quota: DEFAULT_MONTHLY_REQUEST_QUOTA,
          created_at: Date.now(),
        },
      ]
    }

    const keys = rows.map((r) => {
      const lastUsed = deps.usageDb
        .query("SELECT MAX(ts) AS t FROM usage WHERE key_label = ?")
        .get(r.label) as { t: number | null }
      return {
        id: r.id,
        label: r.label,
        secret_preview: previewKey(r.secret),
        rpm: r.rpm,
        monthly_token_quota: r.monthly_token_quota,
        monthly_request_quota: r.monthly_request_quota,
        created_at: r.created_at,
        last_used_at: lastUsed.t,
      }
    })

    return c.json({ keys })
  })

  // ─── POST /api/user/keys/rotate ───────────────────────────────
  app.post("/api/user/keys/rotate", auth, (c) => {
    const cust = c.get("customer")
    const newSecret = generateKey()
    const newLabel = `dash_${cust.id}_${Date.now()}`

    deps.usageDb.transaction(() => {
      deps.usageDb.run(
        `UPDATE keys SET disabled = 1
         WHERE tenant_id = ? AND kind = 'static' AND disabled = 0`,
        cust.id,
      )
      deps.usageDb.run(
        `INSERT INTO keys (kind, label, secret, tenant_id, rpm, monthly_token_quota, monthly_request_quota, scopes, disabled, created_at, notes)
         VALUES ('static', ?, ?, ?, ?, ?, ?, '*', 0, ?, 'rotated via dashboard')`,
        newLabel,
        newSecret,
        cust.id,
        DEFAULT_RPM,
        DEFAULT_MONTHLY_TOKEN_QUOTA,
        DEFAULT_MONTHLY_REQUEST_QUOTA,
        Date.now(),
      )
    })()

    const created = deps.usageDb
      .query("SELECT id, created_at FROM keys WHERE secret = ?")
      .get(newSecret) as { id: number; created_at: number }

    return c.json({
      key: {
        id: created.id,
        label: newLabel,
        secret: newSecret,
        rpm: DEFAULT_RPM,
        monthly_token_quota: DEFAULT_MONTHLY_TOKEN_QUOTA,
        monthly_request_quota: DEFAULT_MONTHLY_REQUEST_QUOTA,
        created_at: created.created_at,
      },
    })
  })

  // ─── GET /api/user/usage ──────────────────────────────────────
  app.get("/api/user/usage", auth, (c) => {
    const cust = c.get("customer")
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 90)

    // All key labels owned by this customer (incl. disabled — historical data).
    const labels = (
      deps.usageDb.query("SELECT label FROM keys WHERE tenant_id = ?").all(cust.id) as Array<{
        label: string
      }>
    ).map((r) => r.label)

    if (labels.length === 0) {
      return c.json({ current_period: null, daily: [] })
    }

    // Current quota period: take the most recent active key + its quota_period row.
    const activeKey = deps.usageDb
      .query(
        `SELECT id, monthly_token_quota, monthly_request_quota
         FROM keys WHERE tenant_id = ? AND disabled = 0 ORDER BY id DESC LIMIT 1`,
      )
      .get(cust.id) as {
      id: number
      monthly_token_quota: number
      monthly_request_quota: number
    } | null

    const period = new Date().toISOString().slice(0, 7)
    const quotaRow = activeKey
      ? (deps.usageDb
          .query("SELECT used_tokens, used_requests, reset_at FROM quota_period WHERE key_id = ? AND period = ?")
          .get(activeKey.id, period) as {
          used_tokens: number
          used_requests: number
          reset_at: number
        } | null)
      : null

    const currentPeriod = activeKey
      ? {
          period,
          used_tokens: quotaRow?.used_tokens ?? 0,
          used_requests: quotaRow?.used_requests ?? 0,
          monthly_token_quota: activeKey.monthly_token_quota,
          monthly_request_quota: activeKey.monthly_request_quota,
          reset_at: quotaRow?.reset_at ?? null,
        }
      : null

    // Daily aggregation across ALL of this customer's labels.
    const since = Date.now() - days * 86_400_000
    const placeholders = labels.map(() => "?").join(",")
    const dailyRaw = deps.usageDb
      .query(
        `SELECT date(ts/1000, 'unixepoch') AS d,
                SUM(prompt_tokens) + SUM(completion_tokens) AS tokens,
                COUNT(*) AS requests
         FROM usage
         WHERE key_label IN (${placeholders}) AND ts >= ?
         GROUP BY d ORDER BY d ASC`,
      )
      .all(...labels, since) as Array<{ d: string; tokens: number; requests: number }>

    const daily = dailyRaw.map((r) => ({
      date: r.d,
      tokens: r.tokens ?? 0,
      requests: r.requests ?? 0,
    }))

    return c.json({ current_period: currentPeriod, daily })
  })

  // ─── GET /api/user/settings ───────────────────────────────────
  app.get("/api/user/settings", auth, (c) => {
    const { getUserSettings } = require("../db.ts") as typeof import("../db.ts")
    const cust = c.get("customer")
    return c.json(getUserSettings(deps.licenseDb, cust.id))
  })

  // ─── POST /api/user/settings ──────────────────────────────────
  app.post("/api/user/settings", auth, async (c) => {
    const { upsertUserSettings } = require("../db.ts") as typeof import("../db.ts")
    const cust = c.get("customer")
    const body = (await c.req.json()) as { theme?: string; language?: string }
    const patch: Record<string, string> = {}
    if (body.theme && ["dark", "light", "auto"].includes(body.theme)) patch.theme = body.theme
    if (body.language && ["it", "en"].includes(body.language)) patch.language = body.language
    const updated = upsertUserSettings(deps.licenseDb, cust.id, patch as any)
    return c.json(updated)
  })

  // ─── GET /api/user/security-log ───────────────────────────────
  app.get("/api/user/security-log", auth, (c) => {
    const { getSecurityLog } = require("../db.ts") as typeof import("../db.ts")
    const cust = c.get("customer")
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200)
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined
    return c.json(getSecurityLog(deps.licenseDb, cust.id, { limit, before }))
  })

  // ─── GET /api/user/sessions ───────────────────────────────────
  app.get("/api/user/sessions", auth, (c) => {
    const cust = c.get("customer")
    const currentSid = c.get("sessionId")
    const sessions = deps.licenseDb
      .query(
        `SELECT id, device_label, created_at, last_seen_at, revoked_at
         FROM auth_sessions
         WHERE customer_id = ?
         ORDER BY last_seen_at DESC`,
      )
      .all(cust.id) as Array<{
      id: string
      device_label: string | null
      created_at: number
      last_seen_at: number
      revoked_at: number | null
    }>

    return c.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        device_label: s.device_label,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        is_current: s.id === currentSid,
        revoked: s.revoked_at != null,
      })),
    })
  })

  // ─── POST /api/user/sessions/revoke-all ───────────────────────
  app.post("/api/user/sessions/revoke-all", auth, (c) => {
    const cust = c.get("customer")
    const currentSid = c.get("sessionId")
    deps.licenseDb.run(
      `UPDATE auth_sessions SET revoked_at = ? WHERE customer_id = ? AND id != ? AND revoked_at IS NULL`,
      Date.now(),
      cust.id,
      currentSid,
    )
    return c.json({ ok: true })
  })

  // ─── PATCH /api/user/me ───────────────────────────────────────
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const TG_RE = /^@?[a-zA-Z0-9_]{5,32}$/

  app.patch("/api/user/me", auth, async (c) => {
    const cust = c.get("customer")
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; telegram?: string }
    const updates: Array<[string, string]> = []
    if (body.email !== undefined) {
      if (!EMAIL_RE.test(body.email)) return c.json({ error: "invalid_email" }, 400)
      updates.push(["email", body.email])
    }
    if (body.telegram !== undefined) {
      if (!TG_RE.test(body.telegram)) return c.json({ error: "invalid_telegram" }, 400)
      updates.push(["telegram", body.telegram.startsWith("@") ? body.telegram : `@${body.telegram}`])
    }
    if (updates.length === 0) return c.json({ error: "no_fields_to_update" }, 400)

    const setClause = updates.map(([k]) => `${k} = ?`).join(", ")
    const values = updates.map(([, v]) => v)
    deps.licenseDb.run(`UPDATE customers SET ${setClause} WHERE id = ?`, ...values, cust.id)

    const fresh = deps.licenseDb
      .query("SELECT id, email, telegram, telegram_user_id, approval_status FROM customers WHERE id = ?")
      .get(cust.id) as any
    return c.json(fresh)
  })
}
