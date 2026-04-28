import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"

export const ProjectTable = sqliteTable(
  "project",
  {
    id: text().$type<ProjectID>().primaryKey(),
    worktree: text().notNull(),
    vcs: text(),
    name: text(),
    icon_url: text(),
    icon_color: text(),
    ...Timestamps,
    time_initialized: integer(),
    sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
    commands: text({ mode: "json" }).$type<{ start?: string }>(),
    // Multi-tenant scoping (Phase 1). NULL = legacy/shared (visible to every
    // authenticated caller). Set to the Bearer-token customer's id for new
    // rows so list endpoints can return only the caller's data.
    customer_id: text(),
  },
  (table) => [index("project_customer_idx").on(table.customer_id)],
)
