import { test, expect } from "bun:test"
import { Hono } from "hono"
import { join } from "node:path"
import { makeTestDbs } from "./helpers"
import { runMigrations } from "../src/migrations"
import { makeSessionToken } from "../src/license-auth"

// Set HMAC secret before any imports that use it.
process.env.LICENSE_HMAC_SECRET = "x".repeat(32)

test("end-to-end: me → auto-key → rotate → usage → settings → security-log → revoke → 401", async () => {
  const { license, usage, cleanup } = makeTestDbs()

  // license schema
  license.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT, telegram TEXT, telegram_user_id INTEGER, approval_status TEXT, rejected_reason TEXT);`)
  license.exec(`CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, customer_id TEXT, device_label TEXT, created_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER);`)
  runMigrations(license, join(import.meta.dir, "..", "migrations"))

  // usage schema
  usage.exec(`CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, label TEXT UNIQUE, secret TEXT, tenant_id TEXT, rpm INTEGER, monthly_token_quota INTEGER, monthly_request_quota INTEGER, scopes TEXT, disabled INTEGER DEFAULT 0, created_at INTEGER, notes TEXT);`)
  usage.exec(`CREATE TABLE quota_period (key_id INTEGER, period TEXT, used_tokens INTEGER, used_requests INTEGER, reset_at INTEGER, warned_80 INTEGER, warned_100 INTEGER, UNIQUE(key_id, period));`)
  usage.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, key_label TEXT, ip TEXT, model TEXT, endpoint TEXT, status INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, error TEXT);`)

  // seed customer + session
  license.run(
    "INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)",
    "cus_e2e",
    "e2e@test.com",
    "approved",
  )
  license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)",
    "sid_e2e",
    "cus_e2e",
    "browser",
    Date.now(),
    Date.now(),
  )

  const cookie = `crimeopus_session=${makeSessionToken({ sub: "cus_e2e", tg: null, sid: "sid_e2e" }).token}`
  const h = { Cookie: cookie }

  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: license, usageDb: usage })

  // 1. GET /api/user/me works
  const me = await app.request("/api/user/me", { headers: h })
  expect(me.status).toBe(200)
  expect(((await me.json()) as any).id).toBe("cus_e2e")

  // 2. GET /api/user/keys auto-creates
  const keys = await app.request("/api/user/keys", { headers: h })
  const keysBody = (await keys.json()) as any
  expect(keysBody.keys.length).toBe(1)
  expect(keysBody.keys[0].secret_preview).toMatch(/^sk-/)

  // 3. POST /api/user/keys/rotate
  const rot = await app.request("/api/user/keys/rotate", { method: "POST", headers: h })
  expect(rot.status).toBe(200)
  const rotBody = (await rot.json()) as any
  expect(rotBody.key.secret).toMatch(/^sk-[a-f0-9]{40}$/)

  // 4. GET /api/user/usage works
  const u = await app.request("/api/user/usage", { headers: h })
  expect(u.status).toBe(200)

  // 5. POST /api/user/settings
  const sett = await app.request("/api/user/settings", {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "dark", language: "en" }),
  })
  expect(sett.status).toBe(200)
  expect(((await sett.json()) as any).theme).toBe("dark")

  // 6. GET /api/user/security-log should have events from rotate + settings
  const log = await app.request("/api/user/security-log", { headers: h })
  const logBody = (await log.json()) as any
  const events = logBody.events.map((e: any) => e.event)
  expect(events).toContain("key_rotated")
  expect(events).toContain("settings_updated")

  // 7. POST /api/user/sessions/revoke-all (spares current session)
  // Add a second session so there's something to revoke
  license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)",
    "sid_e2e_other",
    "cus_e2e",
    "phone",
    Date.now(),
    Date.now(),
  )
  const rev = await app.request("/api/user/sessions/revoke-all", { method: "POST", headers: h })
  expect(rev.status).toBe(200)

  // 8. Current session still works (revoke-all spares the active session)
  const after = await app.request("/api/user/me", { headers: h })
  expect(after.status).toBe(200)

  // But the other session is revoked
  const otherSess = license
    .query("SELECT revoked_at FROM auth_sessions WHERE id = ?")
    .get("sid_e2e_other") as any
  expect(otherSess.revoked_at).not.toBeNull()

  cleanup()
})

test("end-to-end: DELETE /api/user/me cascades everything", async () => {
  const { license, usage, cleanup } = makeTestDbs()

  license.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT, telegram TEXT, telegram_user_id INTEGER, approval_status TEXT, rejected_reason TEXT);`)
  license.exec(`CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, customer_id TEXT, device_label TEXT, created_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER);`)
  runMigrations(license, join(import.meta.dir, "..", "migrations"))
  usage.exec(`CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, label TEXT UNIQUE, secret TEXT, tenant_id TEXT, rpm INTEGER, monthly_token_quota INTEGER, monthly_request_quota INTEGER, scopes TEXT, disabled INTEGER DEFAULT 0, created_at INTEGER, notes TEXT);`)
  usage.exec(`CREATE TABLE quota_period (key_id INTEGER, period TEXT, used_tokens INTEGER, used_requests INTEGER, reset_at INTEGER, warned_80 INTEGER, warned_100 INTEGER, UNIQUE(key_id, period));`)
  usage.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, key_label TEXT, ip TEXT, model TEXT, endpoint TEXT, status INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, error TEXT);`)

  license.run("INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)", "cus_del", "del@test.com", "approved")
  license.run("INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)", "sid_del", "cus_del", "browser", Date.now(), Date.now())

  const cookie = `crimeopus_session=${makeSessionToken({ sub: "cus_del", tg: null, sid: "sid_del" }).token}`
  const h = { Cookie: cookie }

  const { mountUserRoutes } = await import("../src/routes/user")
  const app = new Hono()
  mountUserRoutes(app, { licenseDb: license, usageDb: usage })

  // Auto-create key first
  await app.request("/api/user/keys", { headers: h })

  // Delete account
  const del = await app.request("/api/user/me", {
    method: "DELETE",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE-del@test.com" }),
  })
  expect(del.status).toBe(204)

  // Verify cascade
  expect(license.query("SELECT id FROM customers WHERE id = ?").get("cus_del")).toBeNull()
  expect(license.query("SELECT id FROM auth_sessions WHERE customer_id = ?").all("cus_del").length).toBe(0)
  const keys = usage.query("SELECT disabled FROM keys WHERE tenant_id = ?").all("cus_del") as any[]
  expect(keys.every((k: any) => k.disabled === 1)).toBe(true)

  // security_log preserves via SET NULL + snapshot
  const logs = license
    .query("SELECT customer_id, customer_id_snapshot FROM security_log WHERE customer_id_snapshot = ?")
    .all("cus_del") as any[]
  expect(logs.length).toBeGreaterThan(0)
  expect(logs.every((l: any) => l.customer_id === null)).toBe(true)

  cleanup()
})
