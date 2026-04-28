import { Database, eq, sql, desc } from "../storage/db"
import { CloudEventTable } from "./cloud-event.sql"

// Pre-built aggregate queries over the cloud_event table. Used by the
// Telegram bot (admin /syncstats, user /sync) and any future ops dashboard.
// Keep these here so callers don't bring in their own SQL — this is the
// single source of truth for "how do we count cloud events".
export namespace CloudEventQueries {
  export type CustomerStats = {
    totalEvents: number
    uniqueAggregates: number
    firstPushedAt: number | null
    lastPushedAt: number | null
  }

  export type AggregateRow = {
    aggregate_id: string
    eventCount: number
    lastPushedAt: number
  }

  export type GlobalStats = {
    totalEvents: number
    uniqueCustomers: number
    uniqueAggregates: number
  }

  export type CustomerLeaderboardRow = {
    customer_id: string
    eventCount: number
    lastPushedAt: number
  }

  export function statsForCustomer(customerId: string): CustomerStats {
    const row = Database.use((db) =>
      db
        .select({
          totalEvents: sql<number>`count(*)`.mapWith(Number),
          uniqueAggregates: sql<number>`count(distinct ${CloudEventTable.aggregate_id})`.mapWith(Number),
          firstPushedAt: sql<number | null>`min(${CloudEventTable.pushed_at})`.mapWith((v) =>
            v == null ? null : Number(v),
          ),
          lastPushedAt: sql<number | null>`max(${CloudEventTable.pushed_at})`.mapWith((v) =>
            v == null ? null : Number(v),
          ),
        })
        .from(CloudEventTable)
        .where(eq(CloudEventTable.customer_id, customerId))
        .get(),
    )
    return (
      row ?? { totalEvents: 0, uniqueAggregates: 0, firstPushedAt: null, lastPushedAt: null }
    )
  }

  export function topAggregatesForCustomer(customerId: string, limit: number): AggregateRow[] {
    return Database.use((db) =>
      db
        .select({
          aggregate_id: CloudEventTable.aggregate_id,
          eventCount: sql<number>`count(*)`.mapWith(Number),
          lastPushedAt: sql<number>`max(${CloudEventTable.pushed_at})`.mapWith(Number),
        })
        .from(CloudEventTable)
        .where(eq(CloudEventTable.customer_id, customerId))
        .groupBy(CloudEventTable.aggregate_id)
        .orderBy(desc(sql`max(${CloudEventTable.pushed_at})`))
        .limit(limit)
        .all(),
    )
  }

  export function globalStats(): GlobalStats {
    const row = Database.use((db) =>
      db
        .select({
          totalEvents: sql<number>`count(*)`.mapWith(Number),
          uniqueCustomers: sql<number>`count(distinct ${CloudEventTable.customer_id})`.mapWith(Number),
          uniqueAggregates: sql<number>`count(distinct ${CloudEventTable.aggregate_id})`.mapWith(Number),
        })
        .from(CloudEventTable)
        .get(),
    )
    return row ?? { totalEvents: 0, uniqueCustomers: 0, uniqueAggregates: 0 }
  }

  export function topCustomers(limit: number): CustomerLeaderboardRow[] {
    return Database.use((db) =>
      db
        .select({
          customer_id: CloudEventTable.customer_id,
          eventCount: sql<number>`count(*)`.mapWith(Number),
          lastPushedAt: sql<number>`max(${CloudEventTable.pushed_at})`.mapWith(Number),
        })
        .from(CloudEventTable)
        .groupBy(CloudEventTable.customer_id)
        .orderBy(desc(sql`count(*)`))
        .limit(limit)
        .all(),
    )
  }

  /** GDPR / cleanup: drop every row for a customer. Returns rows deleted. */
  export function wipeCustomer(customerId: string): number {
    // Drizzle's .run() on delete returns void in this driver, so we count
    // first and then delete in the same DB context — at most a few ms apart.
    return Database.use((db) => {
      const before =
        db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(CloudEventTable)
          .where(eq(CloudEventTable.customer_id, customerId))
          .get()?.n ?? 0
      db.delete(CloudEventTable).where(eq(CloudEventTable.customer_id, customerId)).run()
      return before
    })
  }
}
