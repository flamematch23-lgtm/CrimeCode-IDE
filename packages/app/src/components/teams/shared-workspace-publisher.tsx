/**
 * SharedWorkspacePublisher — bridge between the router/server context and
 * the team-session shared state.
 *
 *   - HOST  : auto-pushes `{ project_path, server_url, opencode_session_id,
 *              active_file? }` whenever the route changes, so all guests
 *              following us know exactly which workspace + OpenCode session
 *              we're in.
 *   - GUEST : when the local user is following someone, watches the
 *              host's pushed state and auto-navigates / auto-attaches
 *              to the same project + opencode session. The guest's own
 *              file edits and cursor still work normally; they just
 *              start out viewing the same context as the host.
 *
 * Mount once near the top of the React/Solid tree (we put it inside
 * RouterRoot in entry.tsx) — there should never be more than one
 * instance per renderer.
 */
import { createEffect, onCleanup, onMount } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useServer, ServerConnection } from "@/context/server"
import {
  pushSharedState,
  getFollowedCustomer,
  getActiveTeamSession,
  fetchSharedState,
  type SharedWorkspaceState,
} from "@/utils/team-session"
import { getTeamsClient, type TeamEvent } from "@/utils/teams-client"

function readActiveTeamId(): string | null {
  try {
    const raw = localStorage.getItem("client.active-workspace")
    if (!raw) return null
    const p = JSON.parse(raw) as { kind?: string; id?: string }
    return p?.kind === "team" && typeof p.id === "string" ? p.id : null
  } catch {
    return null
  }
}

function parseRoute(path: string): { dir: string | null; sessionId: string | null } {
  // Routes look like: /<dir>/session/<id?> or /<dir>/ or /
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return { dir: null, sessionId: null }
  const dir = decodeURIComponent(segments[0])
  if (dir === "security" || dir === "account" || dir === "r") return { dir: null, sessionId: null }
  // Reserved top-level routes that aren't directories
  let sessionId: string | null = null
  const sessIdx = segments.indexOf("session")
  if (sessIdx >= 0 && segments[sessIdx + 1]) sessionId = decodeURIComponent(segments[sessIdx + 1])
  return { dir, sessionId }
}

export function SharedWorkspacePublisher() {
  const server = useServer()
  const location = useLocation()
  const navigate = useNavigate()

  // ── Auto-publish ───────────────────────────────────────────────────
  // Fires whenever any of the inputs change. The push helper itself
  // debounces (250 ms) and gates on "we're a host with an active team
  // session", so calling it freely here is safe.
  createEffect(() => {
    const path = location.pathname
    const { dir, sessionId } = parseRoute(path)
    const active = getActiveTeamSession()
    if (!active) return // no team session → nothing to push
    const conn = server.current
    const serverUrl = conn?.http?.url ?? null
    const serverUsername = conn?.http?.username ?? undefined
    const state: SharedWorkspaceState = {
      version: 1,
      project_path: dir ?? undefined,
      server_url: serverUrl ?? undefined,
      server_username: serverUsername,
      opencode_session_id: sessionId ?? undefined,
      title: dir ? `${dir}${sessionId ? " · session " + sessionId.slice(0, 8) : ""}` : undefined,
    }
    pushSharedState(state)
  })

  // ── Auto-follow (guest side) ───────────────────────────────────────
  // When following someone, listen to the team SSE stream and react
  // to fresh `session_state` events from that specific host. We hydrate
  // once on mount (so a refresh while-following recovers immediately)
  // and then keep listening.
  let lastNavigatedTo: string | null = null

  function maybeApply(state: SharedWorkspaceState | null | undefined) {
    if (!state) return
    const target = buildRoute(state)
    if (!target) return
    // Avoid a navigate loop: only push if the route actually differs from
    // both the current path and the last thing we auto-navigated to.
    const cur = location.pathname
    if (cur === target || lastNavigatedTo === target) return
    lastNavigatedTo = target
    navigate(target, { replace: true })
    // Optionally swap the active server too, if the host is on a
    // different one (and we already have credentials for it).
    if (state.server_url) maybeSwitchServer(state.server_url, state.server_username)
  }

  function buildRoute(s: SharedWorkspaceState): string | null {
    if (!s.project_path) return null
    const dir = encodeURIComponent(s.project_path)
    if (s.opencode_session_id) {
      return `/${dir}/session/${encodeURIComponent(s.opencode_session_id)}`
    }
    return `/${dir}`
  }

  function maybeSwitchServer(url: string, username?: string) {
    const cur = server.current
    if (cur?.http?.url === url) return
    // Find an existing connection that already has credentials for this URL.
    const match = server.list.find(
      (c: ServerConnection.Any) =>
        c.type === "http" && c.http?.url === url && (!username || c.http?.username === username),
    )
    if (match) {
      server.setActive(ServerConnection.key(match))
    }
    // If we don't have it stored yet, we leave the user on their current
    // server — they can add the host's server manually from the dialog.
  }

  onMount(() => {
    const teamId = readActiveTeamId()
    const followedCid = getFollowedCustomer()
    if (!teamId || !followedCid) return

    let unsubscribe: (() => void) | null = null

    // Hydrate via REST so we apply immediately — useful when the user
    // refreshes the app or starts following somebody who's been live for
    // a while.
    void (async () => {
      const client = getTeamsClient()
      const sessions = await client.listSessions(teamId).catch(() => null)
      const hostSession = sessions?.sessions?.find((s) => s.host_customer_id === followedCid && !s.ended_at)
      if (hostSession) {
        const snapshot = await fetchSharedState(teamId, hostSession.id)
        if (snapshot?.state) maybeApply(snapshot.state as SharedWorkspaceState)
      }
    })()

    // Subscribe to live updates
    const client = getTeamsClient()
    unsubscribe = client.subscribe(teamId, (ev: TeamEvent) => {
      if (ev.type !== "session_state") return
      const fromHost = (ev as { host_customer_id?: string }).host_customer_id
      if (fromHost !== followedCid) return
      const state = (ev as { state?: SharedWorkspaceState }).state
      if (state) maybeApply(state)
    })

    // React to follow changes from the UI
    const onFollowChange = (e: Event) => {
      const cid = (e as CustomEvent<string | null>).detail
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      lastNavigatedTo = null
      if (!cid) return
      // Reuse the same hydrate-then-subscribe sequence
      void (async () => {
        const sessions = await client.listSessions(teamId).catch(() => null)
        const hostSession = sessions?.sessions?.find((s) => s.host_customer_id === cid && !s.ended_at)
        if (hostSession) {
          const snapshot = await fetchSharedState(teamId, hostSession.id)
          if (snapshot?.state) maybeApply(snapshot.state as SharedWorkspaceState)
        }
        unsubscribe = client.subscribe(teamId, (ev: TeamEvent) => {
          if (ev.type !== "session_state") return
          const fromHost = (ev as { host_customer_id?: string }).host_customer_id
          if (fromHost !== cid) return
          const state = (ev as { state?: SharedWorkspaceState }).state
          if (state) maybeApply(state)
        })
      })()
    }
    window.addEventListener("team-following-changed", onFollowChange)

    onCleanup(() => {
      window.removeEventListener("team-following-changed", onFollowChange)
      if (unsubscribe) unsubscribe()
    })
  })

  return null
}
