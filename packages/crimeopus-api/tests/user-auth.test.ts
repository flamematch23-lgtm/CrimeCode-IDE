import { test, expect } from "bun:test"
import { Hono } from "hono"
import { makeTestDbs } from "./helpers"
import { runMigrations } from "../src/migrations"
import { join } from "node:path"

function setupDb() {
  const dbs = makeTestDbs()
  dbs.license.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT, telegram TEXT, telegram_user_id INTEGER, approval_status TEXT, rejected_reason TEXT);`)
  dbs.license.exec(`CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, customer_id TEXT, device_label TEXT, created_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER);`)
  runMigrations(dbs.license, join(import.meta.dir, "..", "migrations"))
  return dbs
}

test("userAuth middleware: missing cookie → 401", async () => {
  const dbs = setupDb()
  const { userAuth } = await import("../src/middleware/user-auth")
  const app = new Hono()
  app.use("*", userAuth({ licenseDb: dbs.license }))
  app.get("/me", (c) => c.json({ ok: true }))

  const res = await app.request("/me")
  expect(res.status).toBe(401)
  dbs.cleanup()
})

test("userAuth middleware: invalid cookie → 401", async () => {
  const dbs = setupDb()
  const { userAuth } = await import("../src/middleware/user-auth")
  const app = new Hono()
  app.use("*", userAuth({ licenseDb: dbs.license }))
  app.get("/me", (c) => c.json({ ok: true }))

  const res = await app.request("/me", {
    headers: { Cookie: "crimeopus_session=garbage" },
  })
  expect(res.status).toBe(401)
  dbs.cleanup()
})

test("userAuth middleware: valid cookie → 200, customer attached", async () => {
  const dbs = setupDb()
  dbs.license.run(
    "INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)",
    "cus_a",
    "a@x.com",
    "approved",
  )
  dbs.license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?,?,?,?,?)",
    "sid_1",
    "cus_a",
    "browser",
    Date.now(),
    Date.now(),
  )

  // Set the HMAC secret for token generation/verification.
  process.env.LICENSE_HMAC_SECRET = "x".repeat(32)

  const { makeSessionToken } = await import("../src/license-auth")
  const { token } = makeSessionToken({ sub: "cus_a", tg: null, sid: "sid_1" })

  const { userAuth } = await import("../src/middleware/user-auth")
  const app = new Hono()
  app.use("*", userAuth({ licenseDb: dbs.license }))
  app.get("/me", (c) => c.json({ customer: c.get("customer") }))

  const res = await app.request("/me", { headers: { Cookie: `crimeopus_session=${token}` } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { customer: { id: string; email: string } }
  expect(body.customer.id).toBe("cus_a")
  expect(body.customer.email).toBe("a@x.com")

  dbs.cleanup()
})

test("userAuth middleware: revoked session → 401", async () => {
  const dbs = setupDb()
  dbs.license.run(
    "INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)",
    "cus_b",
    "b@x.com",
    "approved",
  )
  dbs.license.run(
    "INSERT INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at, revoked_at) VALUES (?,?,?,?,?,?)",
    "sid_revoked",
    "cus_b",
    "browser",
    Date.now(),
    Date.now(),
    Date.now(),
  )

  process.env.LICENSE_HMAC_SECRET = "x".repeat(32)
  const { makeSessionToken } = await import("../src/license-auth")
  const { token } = makeSessionToken({ sub: "cus_b", tg: null, sid: "sid_revoked" })

  const { userAuth } = await import("../src/middleware/user-auth")
  const app = new Hono()
  app.use("*", userAuth({ licenseDb: dbs.license }))
  app.get("/me", (c) => c.json({ ok: true }))

  const res = await app.request("/me", { headers: { Cookie: `crimeopus_session=${token}` } })
  expect(res.status).toBe(401)
  dbs.cleanup()
})
