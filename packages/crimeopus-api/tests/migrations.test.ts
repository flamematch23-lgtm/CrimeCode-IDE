import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeTestDbs } from "./helpers"
import { runMigrations } from "../src/migrations"

test("runMigrations applies pending SQL files in lexicographic order and is idempotent", () => {
  const { license, cleanup } = makeTestDbs()
  const dir = mkdtempSync(join(tmpdir(), "mig-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (x INTEGER);")
  writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (x INTEGER);")

  const applied1 = runMigrations(license, dir)
  expect(applied1.sort()).toEqual(["001_a.sql", "002_b.sql"])

  // Idempotent: running again applies nothing.
  const applied2 = runMigrations(license, dir)
  expect(applied2).toEqual([])

  // Both tables should exist.
  expect(license.query("SELECT name FROM sqlite_master WHERE name='a'").get()).toBeTruthy()
  expect(license.query("SELECT name FROM sqlite_master WHERE name='b'").get()).toBeTruthy()

  cleanup()
})

test("runMigrations creates schema_migrations tracker if missing", () => {
  const { license, cleanup } = makeTestDbs()
  const dir = mkdtempSync(join(tmpdir(), "mig-"))
  runMigrations(license, dir)
  const row = license
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get()
  expect(row).toBeTruthy()
  cleanup()
})

test("the real migrations/ directory applies cleanly to a fresh license DB", () => {
  const { license, cleanup } = makeTestDbs()

  // The real migrations reference customers(id), so create that table first
  // (in production it's created by license-auth.ts at boot).
  license.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      email TEXT,
      telegram TEXT,
      telegram_user_id INTEGER,
      approval_status TEXT,
      rejected_reason TEXT
    );
  `)

  const dir = join(import.meta.dir, "..", "migrations")
  const applied = runMigrations(license, dir)
  expect(applied).toContain("001_user_settings.sql")
  expect(applied).toContain("002_security_log.sql")

  // user_settings exists with right columns
  const cols = license.query("PRAGMA table_info(user_settings)").all() as any[]
  const colNames = cols.map((c) => c.name)
  expect(colNames).toEqual(["customer_id", "theme", "language", "updated_at"])

  // security_log exists with right columns
  const cols2 = license.query("PRAGMA table_info(security_log)").all() as any[]
  const colNames2 = cols2.map((c) => c.name)
  expect(colNames2).toContain("customer_id_snapshot")
  expect(colNames2).toContain("event")

  cleanup()
})
