import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { HTTPException } from "hono/http-exception"
import z from "zod"
import { Database, eq, and, gt, sql } from "../../storage/db"
import { CloudEventTable } from "../../sync/cloud-event.sql"
import { Log } from "../../util/log"
import { CloudClient } from "../../sync/cloud-client"

const log = Log.create({ service: "sync" })

// Wire-format for a single replicated event. Mirrors SyncEvent.SerializedEvent
// but trimmed to the fields the cloud actually needs to store and replay.
const EventWire = z.object({
  id: z.string(),
  aggregateID: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})
type EventWire = z.infer<typeof EventWire>

const PushBody = z.object({
  events: z.array(EventWire).max(500),
})

const ConfigureBody = z.object({
  api: z.string().url(),
  token: z.string().min(8),
})

function requireCustomer(c: { get: (k: never) => unknown }): string {
  const id = c.get("customer_id" as never) as string | undefined
  if (!id) {
    throw new HTTPException(401, { message: "sync requires Bearer authentication" })
  }
  return id
}

export const SyncRoutes = () =>
  new Hono()
    // POST /sync/push — bulk-replicate local events to the cloud.
    // Idempotent on (customer_id, aggregate_id, seq): re-pushing the same
    // event is a no-op so clients can retry freely after partial failures.
    .post(
      "/push",
      describeRoute({
        summary: "Push events to the cloud event log",
        operationId: "sync.push",
        responses: {
          200: { description: "Events accepted" },
          401: { description: "Missing or invalid Bearer token" },
        },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const json = await c.req.json().catch(() => null)
        const parsed = PushBody.safeParse(json)
        if (!parsed.success) {
          throw new HTTPException(400, { message: "invalid push body: " + parsed.error.message })
        }
        const events = parsed.data.events
        if (events.length === 0) return c.json({ accepted: 0 })

        const now = Date.now()
        const rows = events.map((e) => ({
          customer_id: customerId,
          aggregate_id: e.aggregateID,
          seq: e.seq,
          id: e.id,
          type: e.type,
          data: e.data,
          pushed_at: now,
        }))

        Database.use((db) =>
          db
            .insert(CloudEventTable)
            .values(rows)
            .onConflictDoNothing({ target: [CloudEventTable.customer_id, CloudEventTable.aggregate_id, CloudEventTable.seq] })
            .run(),
        )

        log.info("push accepted", { customerId, count: events.length })
        return c.json({ accepted: events.length, pushed_at: now })
      },
    )
    // GET /sync/pull?since={cursor} — return events for this customer
    // strictly newer than the cursor (a millisecond pushed_at timestamp).
    // Caller persists the returned cursor and uses it on the next call.
    .get(
      "/pull",
      describeRoute({
        summary: "Pull events from the cloud event log",
        operationId: "sync.pull",
        responses: {
          200: { description: "Events list" },
          401: { description: "Missing or invalid Bearer token" },
        },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const sinceRaw = c.req.query("since") ?? "0"
        const since = Number.parseInt(sinceRaw, 10)
        if (!Number.isFinite(since) || since < 0) {
          throw new HTTPException(400, { message: "invalid 'since' cursor" })
        }
        const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "500", 10), 1), 1000)

        const rows = Database.use((db) =>
          db
            .select()
            .from(CloudEventTable)
            .where(and(eq(CloudEventTable.customer_id, customerId), gt(CloudEventTable.pushed_at, since)))
            .orderBy(CloudEventTable.pushed_at, CloudEventTable.aggregate_id, CloudEventTable.seq)
            .limit(limit)
            .all(),
        )

        const cursor = rows.reduce((max, r) => (r.pushed_at > max ? r.pushed_at : max), since)
        const events = rows.map((r) => ({
          id: r.id,
          aggregateID: r.aggregate_id,
          seq: r.seq,
          type: r.type,
          data: r.data,
        }))
        return c.json({ events, cursor, more: rows.length === limit })
      },
    )
    // POST /sync/configure — runtime configuration of the local sidecar's
    // cloud client. Renderer calls this after a successful Telegram login,
    // passing the cloud API URL and the Bearer session token. The sidecar
    // then takes over: initial pull, debounced push, periodic poll.
    .post(
      "/configure",
      describeRoute({
        summary: "Configure the local cloud sync client",
        operationId: "sync.configure",
        responses: {
          200: { description: "Configuration accepted" },
          400: { description: "Invalid configuration body" },
        },
      }),
      async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = ConfigureBody.safeParse(json)
        if (!parsed.success) {
          throw new HTTPException(400, { message: "invalid configure body: " + parsed.error.message })
        }
        await CloudClient.configure(parsed.data.api, parsed.data.token)
        return c.json({ configured: true })
      },
    )
    // POST /sync/sync-now — manual trigger (for "Sync now" buttons in the UI).
    .post(
      "/sync-now",
      describeRoute({
        summary: "Trigger a sync round-trip immediately",
        operationId: "sync.now",
        responses: { 200: { description: "Sync attempted" } },
      }),
      async (c) => {
        const result = await CloudClient.syncOnce()
        return c.json(result)
      },
    )
    // GET /sync/status — observability for the renderer.
    .get(
      "/status",
      describeRoute({
        summary: "Cloud sync status",
        operationId: "sync.status",
        responses: { 200: { description: "Status" } },
      }),
      async (c) => {
        return c.json(CloudClient.getStatus())
      },
    )

// Re-export so callers don't need to know about the table file directly.
export { CloudEventTable }
// Suppress unused warning for the sql template tag (kept for future filters).
void sql
