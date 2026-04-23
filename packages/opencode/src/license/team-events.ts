/**
 * Tiny in-process pub/sub for team events. SSE handlers subscribe per
 * teamId; CRUD code in teams.ts publishes via emitTeamEvent(...).
 *
 * Single-process only — Fly auto-stop is off and we run min_machines=1, so
 * all subscribers and publishers live in the same Node heap. If we ever
 * scale horizontally we'd swap this for Redis pub/sub.
 */

export type TeamEvent =
  | { type: "session_started"; team_id: string; session_id: string; host: string; title: string }
  | { type: "session_heartbeat"; team_id: string; session_id: string }
  | { type: "session_ended"; team_id: string; session_id: string }
  | { type: "member_added"; team_id: string; customer_id: string }
  | { type: "member_removed"; team_id: string; customer_id: string }
  | { type: "member_role_changed"; team_id: string; customer_id: string; role: string }
  | { type: "team_renamed"; team_id: string; name: string }
  | { type: "team_deleted"; team_id: string }

type Listener = (event: TeamEvent) => void

const listeners = new Map<string, Set<Listener>>()

export function subscribeTeam(teamId: string, fn: Listener): () => void {
  const set = listeners.get(teamId) ?? new Set<Listener>()
  set.add(fn)
  listeners.set(teamId, set)
  return () => {
    const s = listeners.get(teamId)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) listeners.delete(teamId)
  }
}

export function emitTeamEvent(event: TeamEvent): void {
  const set = listeners.get(event.team_id)
  if (!set) return
  // Snapshot to avoid mutation during iteration if a handler unsubscribes.
  for (const fn of [...set]) {
    try {
      fn(event)
    } catch {
      // never let a buggy listener take down the publisher
    }
  }
}

export function listenerCount(teamId: string): number {
  return listeners.get(teamId)?.size ?? 0
}
