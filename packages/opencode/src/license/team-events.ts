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
  | {
      type: "cursor_moved"
      team_id: string
      session_id: string
      customer_id: string
      x: number // 0..1 normalized viewport X
      y: number // 0..1 normalized viewport Y
      label?: string | null
    }
  | {
      type: "chat_message"
      team_id: string
      message_id: number
      customer_id: string
      author_name: string | null
      text: string
      ts: number
      attachment_url?: string | null
      attachment_type?: string | null
      attachment_size?: number | null
      attachment_name?: string | null
    }
  | {
      type: "chat_typing"
      team_id: string
      customer_id: string
      author_name: string | null
    }
  | {
      type: "session_state"
      team_id: string
      session_id: string
      host_customer_id: string
      // Whatever JSON blob the host pushed — the canonical shape lives in
      // packages/app/src/utils/team-session.ts (SharedWorkspaceState).
      state: unknown
      ts: number
    }
  | {
      type: "crdt_sync"
      team_id: string
      session_id: string
      doc_id: string
      update_b64: string
      from_customer_id: string
    }
  | {
      type: "crdt_awareness"
      team_id: string
      session_id: string
      doc_id: string
      awareness_b64: string
      from_customer_id: string
    }

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
