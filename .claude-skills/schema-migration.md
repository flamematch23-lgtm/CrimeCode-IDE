---
name: schema-migration
description: Use when changing any database schema, API shape, or persisted file format. Forces migration-first thinking so the running system stays bootable through every step of the change.
---

# Schema Migration

## Overview

Schema changes are the single highest-risk class of code change. A
broken migration doesn't just fail — it leaves the database in a state
where rollback also fails. This skill forces a disciplined sequence so
the system stays bootable at every step.

## When to Use

Trigger for any of:

- Adding/removing/renaming a column on a SQL table
- Changing the JSON shape of a column with `mode: "json"`
- Adding/removing/renaming a Drizzle schema field
- Changing the response shape of an HTTP endpoint that's already public
- Changing the wire format of a queued message / event
- Bumping a major version of a library that touches stored state

**Don't skip when**:
- "It's just a new optional column" → still write the migration
- "The migration is obvious from the diff" → write it explicitly
- "Old data is fine to drop" → confirm with user, don't assume

## The Process

### Phase 1: Plan the shape change

Before touching code, document:

1. **What's the old shape?** (column types, JSON structure, response format)
2. **What's the new shape?**
3. **What's the transformation?** (default value? compute from existing? null-allowed?)
4. **Is the change backward-compatible at the wire?** (i.e. can old clients still read new server responses?)
5. **What happens to existing rows?** (default, backfill, leave NULL?)

Output as a short ADR-style block. The user reviews this **before** any
code is written.

### Phase 2: Write the migration

Use the project's existing migration format:

- Drizzle SQL migrations: `packages/opencode/migration/<timestamp>_<name>/migration.sql`
- Idempotent ALTER patterns: `packages/opencode/src/license/db.ts` (the
  license DB uses raw `ALTER TABLE` wrapped in try/catch).

The migration must:

- Be **forward-only**. Don't write a "down" migration unless the project
  uses one — they get dangerous quickly.
- Use `IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN` (allow re-run).
- Set a sane default for new columns (NULL is acceptable when the new
  column means "legacy / unset").
- Include an INDEX if the new column will be in a WHERE clause.
- Have a unique timestamp prefix so it sorts after every existing
  migration (use `date -u +%Y%m%d%H%M%S`).

### Phase 3: Update the schema definition

After the migration:

- For Drizzle: update the `*.sql.ts` file to match the new table shape.
- For raw SQL: update the `CREATE TABLE` template at the top of the file
  *and* the ALTER ops list (so a fresh DB and an upgraded DB end up the
  same).
- For TS types / Zod schemas: extend, don't replace, when possible.

### Phase 4: Update read sites

Update queries / fromRow helpers / response DTOs so the new shape is
visible. **Do not** update write sites yet.

### Phase 5: Update write sites with backward compat

When INSERTing or UPDATING:

- New optional column → leave default; only set it on the code paths
  that need it.
- New required column → backfill with a default in the SAME commit.
- Renamed column → write to **both** the old and new column for one
  release, switch reads to new, drop old in a follow-up.

### Phase 6: Migration safety check

Before committing, run:

```bash
# Spin up a fresh DB, apply migrations, run the affected test
TEST_DB=$(mktemp).db
OPENCODE_DB=$TEST_DB bun run --cwd packages/opencode src/index.ts serve --hostname 127.0.0.1 --port 0 &
sleep 3
bun -e "import { Database } from 'bun:sqlite'; const db = new Database('$TEST_DB'); console.log(db.prepare('PRAGMA table_info(<table>)').all())"
```

Confirm the new column / shape is present and the existing rows still
parse with the new fromRow helper.

## Red Flags

| Thought | Reality |
|---|---|
| "Migration's auto, I just edit the schema file" | No. Write the migration explicitly so a re-run on a different machine produces the same DB. |
| "I'll backfill in production after deploy" | NO. The deploy IS the backfill window. Code in the new version must work with both shapes. |
| "Drop the old column in this PR" | NO. Rename = add new + write both + read new + drop old over **3 separate releases**. |
| "Default NULL is fine, the app will handle it" | Verify. Add a test that loads the legacy shape and asserts the new fromRow output. |
| "It's a JSON column, I can change the shape freely" | NO. The serialized shape is part of your wire format. Migrate it like a column. |

## Output Format

Document the migration as:

```
=== Schema migration: <name> ===

Old shape:
  customers (id TEXT PK, telegram TEXT, telegram_user_id INTEGER)

New shape:
  customers (id TEXT PK, telegram TEXT, telegram_user_id INTEGER,
             approval_status TEXT NOT NULL DEFAULT 'approved',
             approved_at INTEGER)

Migration:
  v2.customers.approval_status — ADD COLUMN approval_status DEFAULT 'approved'
  v2.customers.approved_at     — ADD COLUMN approved_at

Rationale:
  Existing customers default to 'approved' so current users stay
  unblocked. New signups land as 'pending' (handled at INSERT site).

Backfill:
  None needed — existing rows accept the DEFAULT.

Read sites updated:
  - getApprovalStatus(cid)        — new
  - listPendingCustomers(limit)   — new

Write sites updated:
  - signUpWithPassword            — new INSERT specifies approval_status='pending'
  - findOrCreateCustomerByTelegram — same

Rollback plan:
  This migration is forward-only. To "undo", set approval_status='approved'
  on every row (loses information about who was approved when).
```

## Related skills

- `verification-before-completion` — run a fresh-DB boot after the migration
- `pre-commit-review` — runs the typecheck/test pass on the migrated code
