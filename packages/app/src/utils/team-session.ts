/**
 * Active team-session bookkeeping for the renderer.
 *
 * Two localStorage keys drive the live-cursor + presence stack:
 *
 *   client.active-workspace        — the *team* the user picked (written
 *                                    by workspace-switcher, read by
 *                                    live-cursors and others)
 *   client.active-team-session     — the specific live-session id inside
 *                                    that team. THIS is what was missing
 *                                    before — nobody wrote it, so cursor
 *                                    sync never activated.
 *
 * This module owns the session key. Selecting a team automatically joins
 * the team's most-recent active session (or creates a fresh one if there
 * is none), and a small heartbeat loop keeps it warm so the server-side
 * reaper doesn't sweep us. Switching back to "personal" or to a
 * different team tears it down.
 */

import { getTeamsClient, type TeamLiveSession } from "./teams-client"

const SESSION_KEY = "client.active-team-session"
const HEARTBEAT_INTERVAL_MS = 25_000 // server marks stale at 60s; 25s leaves slack

let activeTeamId: string | null = null
let activeSessionId: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function readSessionId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function writeSessionId(sid: string | null): void {
  try {
    if (sid) localStorage.setItem(SESSION_KEY, sid)
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* private mode / quota — non-fatal */
  }
  window.dispatchEvent(new CustomEvent("team-session-changed", { detail: sid }))
}

function clearHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat(teamId: string, sessionId: string): void {
  clearHeartbeat()
  const client = getTeamsClient()
  // First beat is best-effort — if the session was just created the row
  // already has a fresh last_heartbeat_at, no need to wait the full
  // interval before the first refresh.
  void client.heartbeatSession(teamId, sessionId, undefined).catch(() => undefined)
  heartbeatTimer = setInterval(() => {
    if (activeSessionId !== sessionId || activeTeamId !== teamId) {
      // Active changed under us — bail; the new caller's startHeartbeat
      // will replace this timer.
      clearHeartbeat()
      return
    }
    void client.heartbeatSession(teamId, sessionId, undefined).catch(() => undefined)
  }, HEARTBEAT_INTERVAL_MS)
}

/**
 * Pick (or create) an active session for `teamId`, wire it up, and start
 * heartbeating. Idempotent: calling twice with the same team id is a
 * no-op after the second call. Best-effort: if the API rejects (network,
 * 401, 403) the session id stays null and the caller keeps working — the
 * worst that happens is cursor sync stays off until next attempt.
 */
export async function joinOrStartTeamSession(teamId: string): Promise<string | null> {
  if (!teamId) return null
  if (activeTeamId === teamId && activeSessionId) return activeSessionId
  // Switching teams: drop any prior session first so heartbeats don't
  // bleed across teams.
  if (activeTeamId && activeTeamId !== teamId) {
    await leaveActiveTeamSession()
  }
  const client = getTeamsClient()
  let sid: string | null = null
  try {
    const list = await client.listSessions(teamId)
    const active = (list?.sessions ?? []).find((s: TeamLiveSession) => !s.ended_at)
    if (active) {
      sid = active.id
    } else {
      const fresh = await client.publishSession(teamId, "Live workspace", {})
      sid = fresh?.id ?? null
    }
  } catch {
    sid = null
  }
  if (!sid) return null
  activeTeamId = teamId
  activeSessionId = sid
  writeSessionId(sid)
  startHeartbeat(teamId, sid)
  return sid
}

/**
 * End the heartbeat loop and clear the session-id key. If `endRemote` is
 * true and we created the session ourselves we ask the server to mark it
 * ended; otherwise we just disconnect (other members may still be in it).
 */
export async function leaveActiveTeamSession(opts: { endRemote?: boolean } = {}): Promise<void> {
  const teamId = activeTeamId
  const sid = activeSessionId
  activeTeamId = null
  activeSessionId = null
  clearHeartbeat()
  writeSessionId(null)
  if (opts.endRemote && teamId && sid) {
    try {
      await getTeamsClient().endSession(teamId, sid)
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Read-only accessor for UIs that want to show "you are in session X
 * for team Y" without subscribing to the localStorage event bus. Returns
 * `{teamId, sessionId}` only when both are set; otherwise null.
 */
export function getActiveTeamSession(): { teamId: string; sessionId: string } | null {
  if (!activeTeamId || !activeSessionId) return null
  return { teamId: activeTeamId, sessionId: activeSessionId }
}

// ─── Shared workspace state ──────────────────────────────────────────────

/**
 * Canonical shape of the JSON blob a host publishes for the rest of the
 * team to mirror. Anything outside this list is allowed but ignored by
 * the standard UI — extending it is fine, just keep `version` so old
 * guests degrade gracefully.
 *
 * The point of having a contract here is so that a future session
 * "follower" can replay the same workspace deterministically (open the
 * project, attach to the same OpenCode session, scroll to the same
 * file) without ad-hoc keys.
 */
export interface SharedWorkspaceState {
  version: 1
  /** absolute path to the project root the host has open */
  project_path?: string
  /** the OpenCode server the host is talking to (so guests can attach) */
  server_url?: string
  /** if the server is HTTP-Basic, transmit the username (NEVER the
   * password — the user must already have it cached locally). */
  server_username?: string
  /** the OpenCode session id the host is currently inside */
  opencode_session_id?: string
  /** workspace path of the file the host is viewing (relative to project_path) */
  active_file?: string
  /** small "what am I looking at" caption for the UI */
  title?: string
  /** epoch ms — set by the publisher; used to ignore stale events */
  ts?: number
}

const FOLLOW_KEY = "client.team-following-customer"
let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingState: SharedWorkspaceState | null = null

/**
 * Publish the local workspace state up to the active team session so
 * other members can mirror what we're looking at. Coalesced over a
 * 250 ms window — call this on every "interesting" event (project open,
 * session switch, file change, scroll) and the network pressure stays
 * sane.
 *
 * Only the host of the active session can push state; if we're a guest
 * (or no session is active) the call is a no-op.
 */
export function pushSharedState(state: SharedWorkspaceState): void {
  if (!activeTeamId || !activeSessionId) return
  pendingState = { ...state, version: 1, ts: Date.now() }
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer)
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null
    const out = pendingState
    pendingState = null
    if (!out || !activeTeamId || !activeSessionId) return
    void getTeamsClient()
      .heartbeatSession(activeTeamId, activeSessionId, out)
      .catch(() => undefined)
  }, 250)
}

/** Return the customer_id the local user is currently following (or null). */
export function getFollowedCustomer(): string | null {
  try {
    return localStorage.getItem(FOLLOW_KEY)
  } catch {
    return null
  }
}

/**
 * Mark `customerId` as the member we want to mirror. Pass null to stop
 * following. Fires a `team-following-changed` window event so panels can
 * react without polling.
 */
export function setFollowedCustomer(customerId: string | null): void {
  try {
    if (customerId) localStorage.setItem(FOLLOW_KEY, customerId)
    else localStorage.removeItem(FOLLOW_KEY)
  } catch {
    /* private mode — non fatal */
  }
  window.dispatchEvent(new CustomEvent("team-following-changed", { detail: customerId }))
}

/**
 * Fetch the most recent shared state for a session — used by guests on
 * first attach so they don't have to wait for the next push to know
 * what the host is currently viewing.
 */
export async function fetchSharedState(
  teamId: string,
  sessionId: string,
): Promise<{ state: SharedWorkspaceState | null; host_customer_id: string } | null> {
  const client = getTeamsClient()
  const fn = (client as unknown as { getSession?: typeof getSession }).getSession ?? getSession
  return fn(teamId, sessionId).catch(() => null)
}

async function getSession(
  teamId: string,
  sessionId: string,
): Promise<{ state: SharedWorkspaceState | null; host_customer_id: string } | null> {
  // Routed through the desktop IPC bridge if available, web fetch otherwise.
  const isDesktop = typeof window !== "undefined" && typeof (window as unknown as { api?: { teams?: { getSession?: unknown } } }).api?.teams?.getSession === "function"
  if (isDesktop) {
    return (window as unknown as {
      api: {
        teams: {
          getSession: (
            id: string,
            sid: string,
          ) => Promise<{ state: unknown; host_customer_id: string } | null>
        }
      }
    }).api.teams
      .getSession(teamId, sessionId)
      .then((r) => (r ? { state: (r.state as SharedWorkspaceState | null) ?? null, host_customer_id: r.host_customer_id } : null))
      .catch(() => null)
  }
  const headers: Record<string, string> = {}
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("crimecode.session") : null
    if (raw) {
      const parsed = JSON.parse(raw) as { token?: string }
      if (parsed.token) headers.Authorization = `Bearer ${parsed.token}`
    }
  } catch {
    /* private mode or corrupt JSON — fall through with empty headers */
  }
  const session = await fetch(
    `https://api.crimecode.cc/license/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sessionId)}`,
    { headers },
  ).then((r) => (r.ok ? r.json() : null))
  if (!session) return null
  return { state: (session.state as SharedWorkspaceState | null) ?? null, host_customer_id: session.host_customer_id }
}

/**
 * Hydrate this module from localStorage on app boot. Called once from
 * the app entry so a page reload re-attaches to the same session and
 * the heartbeat resumes without the user having to re-pick the team.
 */
export function hydrateTeamSessionFromStorage(): void {
  if (activeSessionId) return
  const sid = readSessionId()
  if (!sid) return
  // We only have the session id in storage; the team id comes from the
  // workspace-switcher's key. If for some reason the workspace key is
  // gone we keep the sid in storage but skip heartbeating until a real
  // join call sets activeTeamId.
  try {
    const raw = localStorage.getItem("client.active-workspace")
    if (raw) {
      const parsed = JSON.parse(raw) as { kind?: string; id?: string }
      if (parsed?.kind === "team" && typeof parsed.id === "string") {
        activeTeamId = parsed.id
        activeSessionId = sid
        startHeartbeat(parsed.id, sid)
      }
    }
  } catch {
    /* ignore */
  }
}
