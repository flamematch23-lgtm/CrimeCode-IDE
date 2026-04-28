import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { eq, and } from "@/storage/db"
import { EventTable, EventSequenceTable } from "../event.sql"
import { Database } from "@/storage/db"
import { Authorization } from "@/server/middleware/auth"

export const SyncRoutes = new Hono()
  .use("/sync/*", Authorization())
  
  // Push events to cloud
  .put(
    "/sync/:key",
    describeRoute({
      summary: "Push sync data",
      operationId: "sync.push",
      request: {
        body: {
          content: {
            "application/json": {
              schema: resolver(z.object({
                value: z.string(),
                updated_at: z.number().optional(),
              })),
            },
          },
        },
      },
      responses: {
        200: { description: "Data synced" },
      },
    }),
    async (c) => {
      const key = c.req.param("key")
      const body = await c.req.json()
      const now = Date.now()
      
      await Database.use((db) =>
        db.insert(EventTable)
          .values({
            id: key,
            aggregate_id: key,
            seq: 0,
            type: "sync",
            data: { value: body.value, updated_at: body.updated_at ?? now },
          })
          .onConflictDoUpdate({
            target: EventTable.id,
            set: {
              data: { value: body.value, updated_at: now },
            },
          })
          .run()
      )
      
      return c.json({ ok: true })
    },
  )
  
  // Pull sync data from cloud
  .get(
    "/sync/:key",
    describeRoute({
      summary: "Pull sync data",
      operationId: "sync.pull",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: resolver(z.object({
                key: z.string(),
                value: z.string(),
                updated_at: z.number(),
              })),
            },
          },
        },
      },
    }),
    async (c) => {
      const key = c.req.param("key")
      const row = await Database.use((db) =>
        db.select()
          .from(EventTable)
          .where(and(eq(EventTable.id, key), eq(EventTable.type, "sync")))
          .get()
      )
      
      if (!row) return c.json({ key, value: "", updated_at: 0 })
      
      return c.json({
        key,
        value: (row.data as any).value ?? "",
        updated_at: (row.data as any).updated_at ?? row.time_created,
      })
    },
  )
  
  // List all sync keys for user
  .get(
    "/sync",
    describeRoute({
      summary: "List sync data",
      operationId: "sync.list",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: resolver(z.object({
                entries: z.array(z.object({
                  key: z.string(),
                  updated_at: z.number(),
                })),
              })),
            },
          },
        },
      },
    }),
    async (c) => {
      const rows = await Database.use((db) =>
        db.select({
          id: EventTable.id,
          updated_at: EventTable.time_updated,
        })
          .from(EventTable)
          .where(eq(EventTable.type, "sync"))
          .all()
      )
      
      return c.json({
        entries: rows.map((r) => ({
          key: r.id,
          updated_at: r.updated_at ?? 0,
        })),
      })
    },
  )
