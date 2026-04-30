import { test, expect } from "bun:test"
import { Hono } from "hono"
import { join } from "node:path"
import { makeTestDbs } from "./helpers"
import { runMigrations } from "../src/migrations"
import { makeSessionToken } from "../src/license-auth"

// Set HMAC secret before any imports that use it.
process.env.LICENSE_HMAC_SECRET = "x".repeat(32)

function bootstrapApp() {
  const dbs = makeTestDbs()
  const { license, usage } = dbs

  // license schema
  license.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT, telegram TEXT, telegram_user_id INTEGER, approval_status TEXT, rejected_reason TEXT);`)
  license.exec(`CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, customer_id TEXT, device_label TEXT, created_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER);`)
  runMigrations(license, join(import.meta.dir, "..", "migrations"))

  // usage schema (matching the prod schema)
  usage.exec(`CREATE TABLE keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, label TEXT UNIQUE, secret TEXT, tenant_id TEXT,
    rpm INTEGER, monthly_token_quota INTEGER, monthly_request_quota INTEGER,
    scopes TEXT, disabled INTEGER DEFAULT 0, created_at INTEGER, notes TEXT
  );`)
  usage.exec(`CREATE TABLE quota_period (
    key_id INTEGER, period TEXT, used_tokens INTEGER, used_requests INTEGER,
    reset_at INTEGER, warned_80 INTEGER, warned_100 INTEGER,
    UNIQUE(key_id, period)
  );`)
  usage.exec(`CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER, key_label TEXT, ip TEXT, model TEXT, endpoint TEXT,
    status INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, error TEXT
  );`)

  // seed customer + session
  license.run(
    "INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)",
    "cus_alice",
    "alice@example.com",
    "approved",
  )
  license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)",
    "sid_alice",
    "cus_alice",
    "browser",
    Date.now(),
    Date.now(),
  )

  return { dbs }
}

function authedRequest(
  app: Hono,
  path: string,
  init?: RequestInit,
  sessionId = "sid_alice",
  sub = "cus_alice",
) {
  const { token } = makeSessionToken({ sub, tg: null, sid: sessionId })
  return app.request(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Cookie: `crimeopus_session=${token}` },
  })
}

// ─── GET /api/user/me ──────────────────────────────────────────

test("GET /api/user/me returns the authed customer", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  const res = await authedRequest(app, "/api/user/me")
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.id).toBe("cus_alice")
  expect(body.email).toBe("alice@example.com")
  expect(body.approval_status).toBe("approved")
  dbs.cleanup()
})

// ─── GET /api/user/keys ────────────────────────────────────────

test("GET /api/user/keys auto-creates a key on first call", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  const res = await authedRequest(app, "/api/user/keys")
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.keys.length).toBe(1)
  expect(body.keys[0].secret_preview).toMatch(/^sk-[a-f0-9]{6}\.\.\.[a-f0-9]{3}$/)
  // full secret never returned by GET
  expect(body.keys[0].secret).toBeUndefined()

  // Second call returns the same key (no duplicate auto-create)
  const res2 = await authedRequest(app, "/api/user/keys")
  const body2 = (await res2.json()) as any
  expect(body2.keys.length).toBe(1)
  expect(body2.keys[0].id).toBe(body.keys[0].id)
  dbs.cleanup()
})

// ─── Tenant isolation ──────────────────────────────────────────

test("tenant isolation: two customers see only their own keys", async () => {
  const { dbs } = bootstrapApp()
  // add a second customer + session
  dbs.license.run(
    "INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)",
    "cus_bob",
    "bob@example.com",
    "approved",
  )
  dbs.license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)",
    "sid_bob",
    "cus_bob",
    "browser",
    Date.now(),
    Date.now(),
  )

  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  const aliceRes = await authedRequest(app, "/api/user/keys")
  const aliceBody = (await aliceRes.json()) as any
  const bobRes = await authedRequest(app, "/api/user/keys", undefined, "sid_bob", "cus_bob")
  const bobBody = (await bobRes.json()) as any

  expect(aliceBody.keys.length).toBe(1)
  expect(bobBody.keys.length).toBe(1)
  expect(aliceBody.keys[0].id).not.toBe(bobBody.keys[0].id)
  dbs.cleanup()
})

// ─── POST /api/user/keys/rotate ────────────────────────────────

test("POST /api/user/keys/rotate disables old, creates new, returns full secret once", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  // Auto-create the first key via GET
  const initial = await authedRequest(app, "/api/user/keys")
  const firstKey = ((await initial.json()) as any).keys[0]

  // Rotate
  const rot = await authedRequest(app, "/api/user/keys/rotate", { method: "POST" })
  expect(rot.status).toBe(200)
  const rotBody = (await rot.json()) as any
  expect(rotBody.key.secret).toMatch(/^sk-[a-f0-9]{40}$/)
  expect(rotBody.key.id).not.toBe(firstKey.id)

  // GET should now show ONLY the new key (old is disabled and filtered out)
  const after = await authedRequest(app, "/api/user/keys")
  const afterBody = (await after.json()) as any
  expect(afterBody.keys.length).toBe(1)
  expect(afterBody.keys[0].id).toBe(rotBody.key.id)
  // full secret is NOT in the GET response
  expect(afterBody.keys[0].secret).toBeUndefined()

  dbs.cleanup()
})

// ─── GET /api/user/usage ───────────────────────────────────────

test("GET /api/user/usage returns current period totals + 30-day series", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  // Trigger key auto-create
  await authedRequest(app, "/api/user/keys")
  const key = dbs.usage.query("SELECT id, label FROM keys WHERE tenant_id = ?").get("cus_alice") as any

  // Seed quota_period and usage
  const period = new Date().toISOString().slice(0, 7) // YYYY-MM
  dbs.usage.run(
    "INSERT INTO quota_period (key_id, period, used_tokens, used_requests, reset_at, warned_80, warned_100) VALUES (?,?,?,?,?,?,?)",
    key.id,
    period,
    12345,
    50,
    Date.now() + 86400_000,
    0,
    0,
  )
  // Two days of usage
  const now = Date.now()
  const dayMs = 86400_000
  dbs.usage.run(
    "INSERT INTO usage (ts, key_label, ip, model, endpoint, status, prompt_tokens, completion_tokens, latency_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?)",
    now - dayMs,
    key.label,
    "1.1.1.1",
    "crimeopus-coder",
    "/v1/chat/completions",
    200,
    70,
    30,
    50,
    null,
  )
  dbs.usage.run(
    "INSERT INTO usage (ts, key_label, ip, model, endpoint, status, prompt_tokens, completion_tokens, latency_ms, error) VALUES (?,?,?,?,?,?,?,?,?,?)",
    now,
    key.label,
    "1.1.1.1",
    "crimeopus-coder",
    "/v1/chat/completions",
    200,
    120,
    80,
    60,
    null,
  )

  const res = await authedRequest(app, "/api/user/usage")
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.current_period.used_tokens).toBe(12345)
  expect(body.current_period.used_requests).toBe(50)
  expect(body.current_period.monthly_token_quota).toBe(1_000_000)
  expect(body.daily.length).toBeGreaterThanOrEqual(2)

  // The most recent day in `daily` should reflect the 200-token entry from `now`.
  const today = new Date(now).toISOString().slice(0, 10)
  const todayEntry = body.daily.find((d: any) => d.date === today)
  expect(todayEntry).toBeTruthy()
  expect(todayEntry.tokens).toBe(200) // 120 prompt + 80 completion

  dbs.cleanup()
})

// ─── GET/POST /api/user/settings ───────────────────────────────

test("settings: returns defaults then persists changes", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  // Defaults
  const res1 = await authedRequest(app, "/api/user/settings")
  expect(res1.status).toBe(200)
  expect(await res1.json()).toEqual({ theme: "auto", language: "it" })

  // Update
  const res2 = await authedRequest(app, "/api/user/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "dark", language: "en" }),
  })
  expect(res2.status).toBe(200)
  expect(await res2.json()).toEqual({ theme: "dark", language: "en" })

  // Persist
  const res3 = await authedRequest(app, "/api/user/settings")
  expect(await res3.json()).toEqual({ theme: "dark", language: "en" })

  dbs.cleanup()
})

// ─── GET /api/user/security-log ────────────────────────────────

test("security-log: empty then populated", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const { appendSecurityEvent } = await import("../src/db")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  const res1 = await authedRequest(app, "/api/user/security-log")
  expect(res1.status).toBe(200)
  expect(((await res1.json()) as any).events.length).toBe(0)

  appendSecurityEvent(dbs.license, {
    customerId: "cus_alice",
    event: "login",
    ip: "1.2.3.4",
    userAgent: "Test",
    metadata: null,
  })

  const res2 = await authedRequest(app, "/api/user/security-log")
  const body2 = (await res2.json()) as any
  expect(body2.events.length).toBe(1)
  expect(body2.events[0].event).toBe("login")

  dbs.cleanup()
})

// ─── GET /api/user/sessions + revoke-all ───────────────────────

test("sessions: lists sessions and revoke-all spares current", async () => {
  const { dbs } = bootstrapApp()
  // Add a second session for alice
  dbs.license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)",
    "sid_other",
    "cus_alice",
    "phone",
    Date.now(),
    Date.now(),
  )

  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  // List — should show 2 sessions
  const list = await authedRequest(app, "/api/user/sessions")
  const listBody = (await list.json()) as any
  expect(listBody.sessions.length).toBe(2)
  const current = listBody.sessions.find((s: any) => s.is_current)
  expect(current).toBeTruthy()

  // Revoke all (except current)
  const rev = await authedRequest(app, "/api/user/sessions/revoke-all", { method: "POST" })
  expect(rev.status).toBe(200)

  // The other session should now be revoked
  const after = await authedRequest(app, "/api/user/sessions")
  const afterBody = (await after.json()) as any
  const revoked = afterBody.sessions.filter((s: any) => s.revoked)
  const active = afterBody.sessions.filter((s: any) => !s.revoked)
  expect(revoked.length).toBe(1)
  expect(active.length).toBe(1)
  expect(active[0].is_current).toBe(true)

  dbs.cleanup()
})

// ─── PATCH /api/user/me ────────────────────────────────────────

test("PATCH /api/user/me updates email", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  const r = await authedRequest(app, "/api/user/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "new@example.com" }),
  })
  expect(r.status).toBe(200)
  const b = (await r.json()) as any
  expect(b.email).toBe("new@example.com")
  dbs.cleanup()
})

test("PATCH /api/user/me rejects invalid email", async () => {
  const { dbs } = bootstrapApp()
  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: dbs.license, usageDb: dbs.usage })

  const r = await authedRequest(app, "/api/user/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  })
  expect(r.status).toBe(400)
  dbs.cleanup()
})
