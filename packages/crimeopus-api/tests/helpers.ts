import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Spin up an isolated pair of SQLite DBs for a test.
 * Returns paths + cleanup. Each call is independent.
 */
export function makeTestDbs() {
  const dir = mkdtempSync(join(tmpdir(), "crimeopus-test-"))
  const usagePath = join(dir, "usage.db")
  const licensePath = join(dir, "license.db")

  const usage = new Database(usagePath)
  const license = new Database(licensePath)

  for (const db of [usage, license]) {
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA foreign_keys = ON;")
  }

  return {
    usagePath,
    licensePath,
    usage,
    license,
    cleanup: () => {
      // Switch to DELETE journal mode to release WAL/SHM files before closing
      // (avoids EBUSY on Windows).
      for (const db of [usage, license]) {
        try {
          db.exec("PRAGMA journal_mode = DELETE;")
        } catch {}
        db.close()
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

/** Inject env vars to load src code with our test DBs. */
export function withTestEnv(usagePath: string, licensePath: string) {
  process.env.LOG_DB = usagePath
  process.env.LICENSE_DB_PATH = licensePath
}
