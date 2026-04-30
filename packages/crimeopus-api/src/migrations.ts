import type { Database } from "bun:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Tiny custom migration runner. Reads .sql files from `dir`, applies any not
 * yet recorded in schema_migrations, in lexicographic order. Idempotent.
 *
 * Convention: filename `NNN_short_description.sql`.
 *
 * Returns the list of filenames that were applied this run (empty if all
 * already applied).
 */
export function runMigrations(db: Database, dir: string): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  } catch {
    return []
  }

  const applied = new Set<string>(
    db
      .query("SELECT filename FROM schema_migrations")
      .all()
      .map((r: any) => r.filename),
  )

  const newlyApplied: string[] = []
  const insertTracker = db.prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)")

  for (const filename of files) {
    if (applied.has(filename)) continue
    const sql = readFileSync(join(dir, filename), "utf8")
    db.transaction(() => {
      db.exec(sql)
      insertTracker.run(filename, Date.now())
    })()
    newlyApplied.push(filename)
  }

  return newlyApplied
}
