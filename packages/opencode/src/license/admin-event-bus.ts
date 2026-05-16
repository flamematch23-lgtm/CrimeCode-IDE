/**
 * In-memory pub/sub for the admin dashboard's live activity feed.
 *
 * Events are emitted from the existing license / payment / team code
 * paths (search for emitAdminEvent callers). Every connected SSE client
 * gets the same event payload in real time. Buffer keeps the last 100
 * events so a freshly-loaded dashboard can backfill its feed without
 * waiting for the next live event.
 *
 * This is intentionally process-local: events aren't persisted, aren't
 * replayed across deploys, and don't sync across Fly machines (we run
 * a single machine for crimecode-api anyway). The full source of truth
 * stays in SQLite — this is a UX shortcut, not a feature.
 */

export type AdminEventType =
  | "signup"
  | "order_created"
  | "order_paid"
  | "order_cancelled"
  | "license_issued"
  | "license_revoked"
  | "crypoverse_paid"
  | "crypoverse_failed"
  | "team_created"
  | "broadcast_sent"
  | "system_error"

export interface AdminEvent {
  id: number
  type: AdminEventType
  ts: number // unix seconds
  payload: Record<string, unknown>
}

const BUFFER_LIMIT = 100

type Subscriber = (ev: AdminEvent) => void

let nextId = 1
const buffer: AdminEvent[] = []
const subscribers = new Set<Subscriber>()

export function emitAdminEvent(type: AdminEventType, payload: Record<string, unknown>): AdminEvent {
  const ev: AdminEvent = {
    id: nextId++,
    type,
    ts: Math.floor(Date.now() / 1000),
    payload,
  }
  buffer.push(ev)
  if (buffer.length > BUFFER_LIMIT) buffer.shift()
  // Fan out to subscribers — wrap each call so a single broken consumer
  // can't poison the whole loop.
  for (const sub of subscribers) {
    try {
      sub(ev)
    } catch {
      // ignore — broken subscriber drops out on next unsubscribe
    }
  }
  return ev
}

/**
 * Subscribe to live events. Returns an unsubscribe handle. The optional
 * `since` argument backfills the buffer (events newer than the supplied
 * id are flushed synchronously before the new live ones start arriving).
 */
export function subscribeAdminEvents(handler: Subscriber, since?: number): () => void {
  if (since != null) {
    for (const ev of buffer) {
      if (ev.id > since) {
        try {
          handler(ev)
        } catch {
          // ignore
        }
      }
    }
  }
  subscribers.add(handler)
  return () => {
    subscribers.delete(handler)
  }
}

export function getRecentEvents(limit = 50): AdminEvent[] {
  if (limit >= buffer.length) return [...buffer]
  return buffer.slice(buffer.length - limit)
}

export function getEventBusStats(): { buffered: number; subscribers: number; next_id: number } {
  return {
    buffered: buffer.length,
    subscribers: subscribers.size,
    next_id: nextId,
  }
}
