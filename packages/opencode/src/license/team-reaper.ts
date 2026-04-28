import { Log } from "../util/log"
import { reapStaleSessions } from "./teams"

const log = Log.create({ service: "team-reaper" })

const REAP_INTERVAL_MS = 30_000 // sweep every 30 seconds
const STALE_AFTER_SEC = 60 // a session that hasn't heartbeated in 60s is dead

let timer: ReturnType<typeof setInterval> | null = null
let stopped = false

/**
 * Start the periodic team-session reaper. Sessions in the license DB are
 * considered "active" while their last_heartbeat_at is recent; if the host
 * crashes or its network drops, the row would otherwise linger as active
 * for up to 90 seconds (the listActiveSessions() cutoff), blocking new
 * sessions and confusing the SSE stream of subscribers. The reaper sweeps
 * every 30s, marks stale rows ended, and emits `session_ended` so
 * subscribers can tear down their UI cleanly.
 *
 * Safe to call multiple times — subsequent calls are no-ops while a timer
 * is already running.
 */
export function startTeamReaper(): void {
  if (timer || stopped) return
  log.info("starting team-session reaper", {
    intervalMs: REAP_INTERVAL_MS,
    staleAfterSec: STALE_AFTER_SEC,
  })
  timer = setInterval(() => {
    try {
      const n = reapStaleSessions(STALE_AFTER_SEC)
      if (n > 0) log.info("reaped stale sessions", { count: n })
    } catch (err) {
      log.warn("reaper sweep failed", { error: err instanceof Error ? err.message : String(err) })
    }
  }, REAP_INTERVAL_MS)
}

export function stopTeamReaper(): void {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
