import { Effect, Layer } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Database, eq } from "../storage/db"
import { EventTable, EventSequenceTable } from "./event.sql"
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
        const rows = yield* Database.use((db) =>
          db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all(),
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
                events: rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, data: r.data })),
              }),
            }),
          catch: (e) => new Error(`Push failed: ${e}`),
        })
      })

      const pull = Effect.fn("sync.pull")(function* (aggregateID: string) {
        if (!cfg) return
        const res = yield* Effect.tryPromise({
          try: () => fetch(`${cfg.api}/sync/pull/${aggregateID}`, { headers: { Authorization: `Bearer ${cfg.token}` } }),
          catch: (e) => new Error(`Pull failed: ${e}`),
        })
        const data = yield* Effect.tryPromise(() => res.json())
        if (data.events) {
          for (const evt of data.events) {
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
    return runPromise((s) => s.setConfig(cfg))
  }

  export function push(aggregateID: string) {
    return runPromise((s) => s.push(aggregateID))
  }

  export function pull(aggregateID: string) {
    return runPromise((s) => s.pull(aggregateID))
  }
}
