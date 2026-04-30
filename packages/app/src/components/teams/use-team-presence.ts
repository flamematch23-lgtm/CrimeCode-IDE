/**
 * useTeamPresence — single source of truth for "who is live in this team
 * right now" used by every UI surface (badge, popover panel, member list,
 * cursor overlay, …).
 *
 * Live-ness is derived from two real-time signals:
 *
 *   1. team-events SSE stream (`session_started` / `session_heartbeat`
 *      / `session_ended` / `cursor_moved` / `member_*`)
 *   2. a periodic listSessions() safety net (every 30 s) so we recover
 *      after an SSE drop / sleep / network blip
 *
 * A member is considered "live" if they either:
 *   - host an active session whose `last_heartbeat_at` is within 90 s, or
 *   - have emitted a `cursor_moved` event within the last 8 s
 *
 * The hook returns reactive accessors so any component that calls it gets
 * automatic re-render whenever the underlying signals change. Multiple
 * call sites in the same team subscribe independently — that's fine,
 * the SSE bridge dedupes streams per team in the Electron main process.
 */
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { getTeamsClient, type TeamMember, type TeamLiveSession, type TeamEvent, type TeamDetail } from "../../utils/teams-client"

export type PresenceState = "live" | "offline"

export interface MemberPresence {
  member: TeamMember
  state: PresenceState
  /** epoch-ms of the last live signal we saw for this member; null = never */
  lastSeenAt: number | null
  /** epoch-ms of the last cursor_moved event from this member */
  cursorAt: number | null
  /** active session this member is hosting, if any */
  session: TeamLiveSession | null
}

const FRESH_SESSION_MS = 90_000 // server reaper kicks in around 60s — leave slack
const FRESH_CURSOR_MS = 8_000

export function useTeamPresence(teamId: () => string | null) {
  const client = getTeamsClient()

  // detail() drives the member list (changes when add/remove/role events fire)
  const [detail, { refetch: refetchDetail }] = createResource<TeamDetail | null, string | null>(
    teamId,
    async (id) => {
      if (!id) return null
      try {
        return await client.detail(id)
      } catch {
        return null
      }
    },
  )

  const [sessions, setSessions] = createSignal<TeamLiveSession[]>([])
  const [cursorActivity, setCursorActivity] = createSignal<Record<string, number>>({})
  const [tick, setTick] = createSignal(0) // forces re-eval of "freshness" once per second
  // sessionStates is keyed by session_id (NOT host customer id) so two
  // members hosting their own sessions don't clobber each other's state.
  const [sessionStates, setSessionStates] = createSignal<Record<string, { state: unknown; ts: number }>>({})

  let unsubscribe: (() => void) | null = null
  let safety: ReturnType<typeof setInterval> | null = null
  let freshnessTick: ReturnType<typeof setInterval> | null = null

  async function refreshSessions(id: string) {
    try {
      const r = await client.listSessions(id)
      setSessions(r.sessions ?? [])
    } catch {
      /* network blip — SSE will reconcile */
    }
  }

  // Wire / rewire whenever the team id changes
  createEffect(() => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    if (safety) {
      clearInterval(safety)
      safety = null
    }
    setSessions([])
    setCursorActivity({})

    const id = teamId()
    if (!id) return

    void refreshSessions(id)
    void refetchDetail()

    unsubscribe = client.subscribe(id, (ev: TeamEvent) => {
      switch (ev.type) {
        case "session_started":
        case "session_ended":
        case "session_heartbeat":
          // sessions changed — refetch the whole list (cheap, server caps it)
          void refreshSessions(id)
          break
        case "member_added":
        case "member_removed":
        case "member_role_changed":
        case "team_renamed":
          void refetchDetail()
          break
        case "team_deleted":
          setSessions([])
          break
        case "cursor_moved":
          if (ev.customer_id) {
            const cid = ev.customer_id
            setCursorActivity((prev) => ({ ...prev, [cid]: Date.now() }))
          }
          break
        case "session_state":
          if (ev.session_id && (ev as { state?: unknown }).state !== undefined) {
            const sid = ev.session_id
            const state = (ev as { state: unknown }).state
            setSessionStates((prev) => ({ ...prev, [sid]: { state, ts: Date.now() } }))
          }
          break
      }
    })

    // Safety: refresh every 30 s in case SSE silently dropped (some
    // proxies / VPNs kill long-lived connections without warning).
    safety = setInterval(() => void refreshSessions(id), 30_000)
  })

  // Drive a 1 Hz tick so memos that depend on freshness windows (e.g. "did
  // this cursor fire less than 8 s ago?") re-evaluate without a fresh
  // event.
  onMount(() => {
    freshnessTick = setInterval(() => setTick((n) => n + 1), 1_000)
    onCleanup(() => {
      if (freshnessTick) clearInterval(freshnessTick)
    })
  })

  // GC stale cursor entries every second so memory doesn't grow with N
  // long-running sessions
  createEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - FRESH_CURSOR_MS
      setCursorActivity((prev) => {
        const next: Record<string, number> = {}
        let dirty = false
        for (const [k, v] of Object.entries(prev)) {
          if (v >= cutoff) next[k] = v
          else dirty = true
        }
        return dirty ? next : prev
      })
    }, 1_000)
    onCleanup(() => clearInterval(t))
  })

  onCleanup(() => {
    if (unsubscribe) unsubscribe()
    if (safety) clearInterval(safety)
  })

  // ── Derived signals ────────────────────────────────────────────────

  const sessionsByHost = createMemo(() => {
    const m = new Map<string, TeamLiveSession>()
    for (const s of sessions()) if (!s.ended_at) m.set(s.host_customer_id, s)
    return m
  })

  const presence = createMemo<MemberPresence[]>(() => {
    tick() // force this memo to re-evaluate every second so "live" -> "offline" transitions actually fire
    const d = detail()
    if (!d) return []
    const liveByHost = sessionsByHost()
    const cursors = cursorActivity()
    const now = Date.now()
    return d.members.map((m) => {
      const session = liveByHost.get(m.customer_id) ?? null
      const cursorAt = cursors[m.customer_id] ?? null
      const sessionFresh = session && now - session.last_heartbeat_at * 1000 < FRESH_SESSION_MS
      const cursorFresh = cursorAt !== null && now - cursorAt < FRESH_CURSOR_MS
      const state: PresenceState = sessionFresh || cursorFresh ? "live" : "offline"
      const lastSeenAt = Math.max(
        session ? session.last_heartbeat_at * 1000 : 0,
        cursorAt ?? 0,
      ) || null
      return { member: m, state, lastSeenAt, cursorAt, session }
    })
  })

  const liveMembers = createMemo(() => presence().filter((p) => p.state === "live"))
  const liveCount = createMemo(() => liveMembers().length)
  const totalMembers = createMemo(() => detail()?.members.length ?? 0)
  const selfCustomerId = createMemo(() => {
    // detail() returns the team with self_role; we can't get our own
    // customer_id from there directly. Best-effort: read from window.api
    // (desktop) or localStorage session (web).
    if (typeof window === "undefined") return null
    const desktopCid = (window as { api?: { account?: { get?: () => Promise<{ customer_id?: string } | null> } } }).api
    void desktopCid // can't await synchronously; the consumer can pass the id explicitly
    try {
      const raw = localStorage.getItem("crimecode.session")
      if (raw) {
        const parsed = JSON.parse(raw) as { customer_id?: string }
        if (parsed.customer_id) return parsed.customer_id
      }
    } catch {
      /* ignore */
    }
    return null
  })

  // Convenience accessor: state of a specific host's live session, or
  // null if they're not hosting / haven't pushed state yet.
  const getStateForHost = (customerId: string): unknown => {
    const s = sessionsByHost().get(customerId)
    if (!s) return null
    return sessionStates()[s.id]?.state ?? null
  }

  return {
    detail,
    sessions,
    presence,
    liveMembers,
    liveCount,
    totalMembers,
    cursorActivity,
    selfCustomerId,
    sessionStates,
    getStateForHost,
    refreshSessions: () => {
      const id = teamId()
      if (id) void refreshSessions(id)
    },
    refreshDetail: () => void refetchDetail(),
  }
}
