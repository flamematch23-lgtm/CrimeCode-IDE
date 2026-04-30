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
import { render } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { useServer, ServerConnection } from "@/context/server"
import {
  pushSharedState,
  getFollowedCustomer,
  getActiveTeamSession,
  fetchSharedState,
  type SharedWorkspaceState,
} from "@/utils/team-session"
import { getTeamsClient, readWebSession, type TeamEvent } from "@/utils/teams-client"
import { SharedEditorProvider, type CrdtTransport, type CrdtMessage } from "./shared-editor-protocol"
import { bindPromptEditor, findPromptEl } from "./bind-prompt-editor"
import { PromptCursorOverlay } from "./prompt-cursor-overlay"

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

  // ── CRDT shared prompt editor ─────────────────────────────────────────
  // When a team session is active, create a SharedEditorProvider backed by
  // the teams HTTP+SSE transport. Bind it to the prompt contenteditable so
  // all session members can co-author a message in real time.
  onMount(() => {
    let crdtProvider: SharedEditorProvider | null = null
    let crdtCleanup: (() => void) | null = null
    let crdtSessionId: string | null = null
    let bindInterval: ReturnType<typeof setInterval> | null = null
    // Solid disposer + DOM node for the remote-cursor overlay. We mount it
    // as a child of the prompt's scroller (which is position: relative).
    let overlayDispose: (() => void) | null = null
    let overlayHost: HTMLDivElement | null = null

    const selfId = readWebSession()?.customer_id ?? null

    function teardownCrdt() {
      if (bindInterval !== null) {
        clearInterval(bindInterval)
        bindInterval = null
      }
      overlayDispose?.()
      overlayDispose = null
      overlayHost?.remove()
      overlayHost = null
      crdtCleanup?.()
      crdtCleanup = null
      crdtProvider?.destroy()
      crdtProvider = null
      crdtSessionId = null
    }

    function setupCrdt(teamId: string, sessionId: string) {
      if (crdtSessionId === sessionId) return // already wired
      teardownCrdt()

      const client = getTeamsClient()
      const docId = `${teamId}:${sessionId}:draft`

      const transport: CrdtTransport = {
        send(msg: CrdtMessage) {
          void client.postCrdt(teamId, sessionId, msg as { type: string; doc_id: string; update_b64?: string; awareness_b64?: string }).catch(() => undefined)
        },
        onMessage(cb) {
          return client.subscribe(teamId, (ev: TeamEvent) => {
            if (ev.from_customer_id && ev.from_customer_id === selfId) return
            if (ev.type === "crdt_sync" && ev.doc_id === docId && ev.update_b64) {
              cb({ type: "crdt.sync", doc_id: ev.doc_id, update_b64: ev.update_b64 })
            } else if (ev.type === "crdt_awareness" && ev.doc_id === docId && ev.awareness_b64) {
              cb({ type: "crdt.awareness", doc_id: ev.doc_id, awareness_b64: ev.awareness_b64 })
            }
          })
        },
      }

      crdtSessionId = sessionId
      crdtProvider = new SharedEditorProvider({
        docId,
        transport,
        user: selfId ? { customer_id: selfId } : undefined,
      })

      // Poll for the prompt element: it may not be in the DOM yet when the
      // team session starts (user is on the home page). Once found, bind and
      // stop polling. Give up after 30 s.
      let bindAttempts = 0
      const providerRef = crdtProvider
      bindInterval = setInterval(() => {
        const el = findPromptEl()
        if (el && !crdtCleanup) {
          clearInterval(bindInterval!)
          bindInterval = null
          crdtCleanup = bindPromptEditor(
            providerRef.doc.getText("draft"),
            el,
            providerRef.awareness,
          )
          // Mount the remote-cursor overlay inside the prompt's scroller
          // (the parent of the contenteditable, which is position: relative).
          // We append our own host div so the overlay can be torn down
          // cleanly without disturbing the existing layout.
          const scroller = el.parentElement
          if (scroller) {
            overlayHost = document.createElement("div")
            overlayHost.className = "absolute inset-0 pointer-events-none"
            scroller.appendChild(overlayHost)
            const selfClientId = providerRef.doc.clientID
            overlayDispose = render(
              () => (
                <PromptCursorOverlay
                  awareness={providerRef.awareness}
                  promptEl={el}
                  selfClientId={selfClientId}
                />
              ),
              overlayHost,
            )
          }
        }
        if (++bindAttempts > 30) {
          clearInterval(bindInterval!)
          bindInterval = null
        }
      }, 1_000)
    }

    function onSessionChanged() {
      const active = getActiveTeamSession()
      if (active) {
        setupCrdt(active.teamId, active.sessionId)
      } else {
        teardownCrdt()
      }
    }

    onSessionChanged()
    window.addEventListener("team-session-changed", onSessionChanged)
    window.addEventListener("workspace-changed", onSessionChanged)
    onCleanup(() => {
      window.removeEventListener("team-session-changed", onSessionChanged)
      window.removeEventListener("workspace-changed", onSessionChanged)
      teardownCrdt()
    })
  })

  // ── Guest follow / host broadcast ─────────────────────────────────────
  onMount(() => {
    const tid = readActiveTeamId()
    if (!tid) return
    const teamId: string = tid

    let unsubscribe: (() => void) | null = null
    // Generation counter prevents a stale async hydrate-then-subscribe from
    // overwriting the current subscription when the user switches who they
    // follow rapidly (e.g. follow A → unfollow → follow B).
    let gen = 0
    const client = getTeamsClient()

    function attachFor(cid: string | null) {
      const myGen = ++gen
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      lastNavigatedTo = null
      if (!cid) return

      void (async () => {
        const sessions = await client.listSessions(teamId).catch(() => null)
        if (gen !== myGen) return // a newer follow change superseded us
        const hostSession = sessions?.sessions?.find((s) => s.host_customer_id === cid && !s.ended_at)
        if (hostSession) {
          const snapshot = await fetchSharedState(teamId, hostSession.id)
          if (gen !== myGen) return
          if (snapshot?.state) maybeApply(snapshot.state as SharedWorkspaceState)
        }
        if (gen !== myGen) return
        unsubscribe = client.subscribe(teamId, (ev: TeamEvent) => {
          if (ev.type !== "session_state") return
          const fromHost = (ev as { host_customer_id?: string }).host_customer_id
          if (fromHost !== cid) return
          const state = (ev as { state?: SharedWorkspaceState }).state
          if (state) maybeApply(state)
        })
      })()
    }

    // Initial attachment based on stored follow target.
    attachFor(getFollowedCustomer())

    // React to follow changes from the UI.
    const onFollowChange = (e: Event) => {
      attachFor((e as CustomEvent<string | null>).detail)
    }
    window.addEventListener("team-following-changed", onFollowChange)

    onCleanup(() => {
      window.removeEventListener("team-following-changed", onFollowChange)
      gen++ // invalidate any in-flight async work
      if (unsubscribe) unsubscribe()
    })
  })

  return null
}
