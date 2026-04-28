import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"

// Cloud-side replication of local SyncEvent rows. Populated by the central
// API server (e.g. crimecode-api.fly.dev) when desktop clients call /sync/push.
// Scoped by customer_id so each user's events are isolated; (customer_id,
// aggregate_id, seq) is the natural primary key — the same triple in the
// local `event` table maps 1:1 here.
export const CloudEventTable = sqliteTable(
  "cloud_event",
  {
    customer_id: text().notNull(),
    aggregate_id: text().notNull(),
    seq: integer().notNull(),
    id: text().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    pushed_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.customer_id, table.aggregate_id, table.seq] }),
    index("cloud_event_customer_pushed_idx").on(table.customer_id, table.pushed_at),
  ],
)

// Client-side scratch space for sync bookkeeping. Holds the last-pushed event
// id and the last-pulled cloud cursor, so subsequent runs only ship deltas.
export const SyncCursorTable = sqliteTable("sync_cursor", {
  key: text().primaryKey(),
  value: text().notNull(),
})
