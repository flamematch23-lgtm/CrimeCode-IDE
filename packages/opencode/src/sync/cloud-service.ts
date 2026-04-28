import { Effect, Layer } from "effect"
import { makeRuntime } from "@/effect/run-service"
import type { Database } from "../storage/db"
import { eq } from "../storage/db"
import { EventTable } from "./event.sql"
import { SyncEvent } from "./index"

export namespace CloudSync {
  export interface Config {
    api: string
    token: string
  }

  export const Service = Layer.effect(
    "CloudSync",
    Effect.gen(function* () {
      let cfg: Config | undefined

      const push = Effect.fn("sync.push")(function* (aggregateID: string) {
        if (!cfg) return
        const db = yield* Effect.promise(() => import("../storage/db"))
        const rows = yield* Effect.promise(() =>
          db.Database.use((d: Database) =>
            d.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()
          )
        )
        yield* Effect.tryPromise({
          try: () =>
            fetch(`${cfg.api}/sync/push`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.token}`,
              },
              body: JSON.stringify({
                aggregateID,
                events: rows.map((r: any) => ({ id: r.id, seq: r.seq, type: r.type, data: r.data })),
              }),
            }),
          catch: (e: unknown) => new Error(`Push failed: ${e}`),
        })
      })

      const pull = Effect.fn("sync.pull")(function* (aggregateID: string) {
        if (!cfg) return
        const res = yield* Effect.tryPromise({
          try: () => fetch(`${cfg.api}/sync/pull/${aggregateID}`, { headers: { Authorization: `Bearer ${cfg.token}` } }),
          catch: (e: unknown) => new Error(`Pull failed: ${e}`),
        })
        const data = yield* Effect.promise(() => res.json())
        if (data.events) {
          for (const evt of data.events as any[]) {
            SyncEvent.replay(evt)
          }
        }
      })

      return {
        setConfig: (c: Config | undefined) => Effect.sync(() => (cfg = c)),
        push,
        pull,
      }
    }),
  )

  const { runPromise } = makeRuntime("CloudSync", Service)

  export function setConfig(cfg: Config | undefined) {
    return runPromise((s: any) => s.setConfig(cfg))
  }

  export function push(aggregateID: string) {
    return runPromise((s: any) => s.push(aggregateID))
  }

  export function pull(aggregateID: string) {
    return runPromise((s: any) => s.pull(aggregateID))
  }
}
