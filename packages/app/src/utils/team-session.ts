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
