import { Database, eq, gt, asc } from "../storage/db"
import { EventTable } from "./event.sql"
import { SyncCursorTable } from "./cloud-event.sql"
import { SyncEvent } from "./index"
import { Log } from "../util/log"

const log = Log.create({ service: "cloud-client" })

// Cursor keys persisted in sync_cursor.
const PUSH_CURSOR = "push:event_id" // last successfully pushed local event id
const PULL_CURSOR = "pull:pushed_at" // last cloud pushed_at we've replayed

const PUSH_DEBOUNCE_MS = 5_000
const POLL_INTERVAL_MS = 60_000
const PUSH_BATCH_SIZE = 200

export namespace CloudClient {
  type Config = { api: string; token: string }
  type Status = {
    configured: boolean
    lastPushAt: number | null
    lastPullAt: number | null
    lastError: string | null
    pushedCount: number
    pulledCount: number
  }

  let config: Config | null = null
  let pushDebounce: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let busUnsub: (() => void) | null = null
  let status: Status = {
    configured: false,
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    pushedCount: 0,
    pulledCount: 0,
  }

  export function getStatus(): Status {
    return { ...status }
  }

  /**
   * Stamp the sidecar with the cloud endpoint and Bearer token. Renderer
   * calls this after a successful Telegram login. We immediately do an
   * initial round-trip, then start the background poller and bus listener.
   */
  export async function configure(api: string, token: string): Promise<void> {
    config = { api: api.replace(/\/+$/, ""), token }
    status.configured = true
    log.info("configured", { api: config.api })

    // Hook local event bus once: after each local mutation, schedule a push.
    if (!busUnsub) {
      busUnsub = SyncEvent.subscribeAll(() => schedulePush())
    }

    // Initial sync (best effort — never throws).
    await syncOnce()

    // Periodic poll.
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      syncOnce().catch(() => {})
    }, POLL_INTERVAL_MS)
  }

  export function isConfigured(): boolean {
    return config !== null
  }

  /**
   * Manually trigger a full round-trip (push pending → pull new). Returns a
   * structured result so the UI can display "Synced N events / pulled M events".
   * Never throws — errors land on `status.lastError`.
   */
  export async function syncOnce(): Promise<{ ok: boolean; pushed: number; pulled: number; error?: string }> {
    if (!config) return { ok: false, pushed: 0, pulled: 0, error: "not configured" }
    let pushed = 0
    let pulled = 0
    try {
      pushed = await pushPending()
      pulled = await pullAndReplay()
      status.lastError = null
      return { ok: true, pushed, pulled }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      status.lastError = msg
      log.error("sync round-trip failed", { error: msg })
      return { ok: false, pushed, pulled, error: msg }
    }
  }

  function schedulePush() {
    if (!config) return
    if (pushDebounce) clearTimeout(pushDebounce)
    pushDebounce = setTimeout(() => {
      pushPending().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        status.lastError = msg
        log.error("debounced push failed", { error: msg })
      })
    }, PUSH_DEBOUNCE_MS)
  }

  async function pushPending(): Promise<number> {
    if (!config) return 0
    let total = 0
    while (true) {
      const cursor = getCursor(PUSH_CURSOR) ?? ""
      const batch = Database.use((db) => {
        let q = db.select().from(EventTable).orderBy(asc(EventTable.id)).limit(PUSH_BATCH_SIZE)
        if (cursor) q = q.where(gt(EventTable.id, cursor)) as typeof q
        return q.all()
      })
      if (batch.length === 0) break

      const wire = batch.map((r) => ({
        id: r.id,
        aggregateID: r.aggregate_id,
        seq: r.seq,
        type: r.type,
        data: r.data,
      }))

      const res = await fetch(`${config.api}/sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ events: wire }),
      })
      if (!res.ok) {
        throw new Error(`push HTTP ${res.status}: ${await res.text().catch(() => "")}`)
      }

      const newCursor = batch[batch.length - 1].id
      setCursor(PUSH_CURSOR, newCursor)
      total += batch.length
      status.pushedCount += batch.length
      status.lastPushAt = Date.now()
      if (batch.length < PUSH_BATCH_SIZE) break
    }
    return total
  }

  async function pullAndReplay(): Promise<number> {
    if (!config) return 0
    let total = 0
    while (true) {
      const sinceStr = getCursor(PULL_CURSOR) ?? "0"
      const since = Number.parseInt(sinceStr, 10) || 0
      const url = `${config.api}/sync/pull?since=${since}&limit=500`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.token}` },
      })
      if (!res.ok) {
        throw new Error(`pull HTTP ${res.status}: ${await res.text().catch(() => "")}`)
      }
      const body = (await res.json()) as {
        events: Array<{ id: string; aggregateID: string; seq: number; type: string; data: Record<string, unknown> }>
        cursor: number
        more: boolean
      }
      for (const evt of body.events) {
        try {
          // SyncEvent.replay is idempotent on (aggregateID, seq) — replaying
          // an event we already have is a no-op. Sequence-mismatch (rare,
          // multi-device conflict) is logged but does not break the loop.
          SyncEvent.replay({
            id: evt.id,
            seq: evt.seq,
            aggregateID: evt.aggregateID,
            type: evt.type,
            data: evt.data as never,
          })
          total += 1
        } catch (err) {
          log.warn("replay skipped", { id: evt.id, aggregateID: evt.aggregateID, seq: evt.seq, error: String(err) })
        }
      }
      setCursor(PULL_CURSOR, String(body.cursor))
      status.pulledCount += body.events.length
      status.lastPullAt = Date.now()
      if (!body.more) break
    }
    return total
  }

  function getCursor(key: string): string | null {
    const row = Database.use((db) => db.select().from(SyncCursorTable).where(eq(SyncCursorTable.key, key)).get())
    return row?.value ?? null
  }

  function setCursor(key: string, value: string) {
    Database.use((db) =>
      db
        .insert(SyncCursorTable)
        .values({ key, value })
        .onConflictDoUpdate({ target: SyncCursorTable.key, set: { value } })
        .run(),
    )
  }

  // Internal hook for graceful shutdown / tests.
  export function _reset() {
    if (pushDebounce) clearTimeout(pushDebounce)
    if (pollTimer) clearInterval(pollTimer)
    if (busUnsub) busUnsub()
    pushDebounce = null
    pollTimer = null
    busUnsub = null
    config = null
    status = {
      configured: false,
      lastPushAt: null,
      lastPullAt: null,
      lastError: null,
      pushedCount: 0,
      pulledCount: 0,
    }
  }
}
