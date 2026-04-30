import { test, expect } from "bun:test"
import { makeTestDbs } from "./helpers"
import { runMigrations } from "../src/migrations"
import { getUserSettings, upsertUserSettings, appendSecurityEvent, getSecurityLog } from "../src/db"
import { join } from "node:path"

function setupLicense() {
  const dbs = makeTestDbs()
  // Pre-create customers table (license-auth.ts owns it in prod)
  dbs.license.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY, email TEXT, telegram TEXT,
      telegram_user_id INTEGER, approval_status TEXT, rejected_reason TEXT
    );
  `)
  dbs.license.run(
    "INSERT INTO customers (id, email, approval_status) VALUES (?,?,?)",
    "cus_alice",
    "alice@example.com",
    "approved",
  )
  runMigrations(dbs.license, join(import.meta.dir, "..", "migrations"))
  return dbs
}

test("getUserSettings returns defaults when no row exists", () => {
  const { license, cleanup } = setupLicense()
  const s = getUserSettings(license, "cus_alice")
  expect(s).toEqual({ theme: "auto", language: "it" })
  cleanup()
})

test("upsertUserSettings persists and getUserSettings reflects them", () => {
  const { license, cleanup } = setupLicense()
  upsertUserSettings(license, "cus_alice", { theme: "light", language: "en" })
  expect(getUserSettings(license, "cus_alice")).toEqual({ theme: "light", language: "en" })
  upsertUserSettings(license, "cus_alice", { theme: "dark" })
  expect(getUserSettings(license, "cus_alice")).toEqual({ theme: "dark", language: "en" })
  cleanup()
})

test("appendSecurityEvent records and getSecurityLog reads it back", () => {
  const { license, cleanup } = setupLicense()
  appendSecurityEvent(license, {
    customerId: "cus_alice",
    event: "login",
    ip: "1.2.3.4",
    userAgent: "TestAgent/1.0",
    metadata: null,
  })
  appendSecurityEvent(license, {
    customerId: "cus_alice",
    event: "key_rotated",
    ip: "1.2.3.4",
    userAgent: "TestAgent/1.0",
    metadata: { old: 1, new: 2 },
  })
  const events = getSecurityLog(license, "cus_alice", { limit: 10 })
  expect(events.events.length).toBe(2)
  expect(events.events[0].event).toBe("key_rotated") // newest first
  expect(events.events[0].metadata).toEqual({ old: 1, new: 2 })
  expect(events.events[1].event).toBe("login")
  cleanup()
})

test("getSecurityLog cursor pagination works", () => {
  const { license, cleanup } = setupLicense()
  for (let i = 0; i < 5; i++) {
    appendSecurityEvent(license, {
      customerId: "cus_alice",
      event: "login",
      ip: `1.1.1.${i}`,
      userAgent: "x",
      metadata: null,
    })
  }
  const page1 = getSecurityLog(license, "cus_alice", { limit: 2 })
  expect(page1.events.length).toBe(2)
  expect(page1.next_cursor).not.toBeNull()
  const page2 = getSecurityLog(license, "cus_alice", { limit: 2, before: page1.next_cursor! })
  expect(page2.events.length).toBe(2)
  // ids must be strictly less than the cursor
  expect(page2.events[0].id).toBeLessThan(page1.next_cursor!)
  cleanup()
})
