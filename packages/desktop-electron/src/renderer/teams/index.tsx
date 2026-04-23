import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { TeamLiveSession } from "../../preload/types"
import { getTeamsClient } from "@opencode-ai/app/utils/teams-client"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { LiveCursors } from "./live-cursors"

export { WorkspaceSwitcher, LiveCursors }

interface ActiveWorkspace {
  kind: "personal" | "team"
  id: string | null
}

function readActive(): ActiveWorkspace {
  try {
    const raw = localStorage.getItem("client.active-workspace")
    if (!raw) return { kind: "personal", id: null }
    const p = JSON.parse(raw)
    if (p?.kind === "team" && typeof p.id === "string") return p
    return { kind: "personal", id: null }
  } catch {
    return { kind: "personal", id: null }
  }
}

/**
 * Runs in the background while the app is in a team workspace:
 *   1. Polls the list of live sessions every 15s.
 *   2. If the local app is an active host (started a session), sends a
 *      heartbeat every 30s so other members see it as live.
 * Cleaned up automatically when the user switches back to personal.
 */
export function TeamPresenceBadge() {
  const client = getTeamsClient()
  const [ws, setWs] = createSignal<ActiveWorkspace>(readActive())
  const [sessions, setSessions] = createSignal<TeamLiveSession[]>([])

  let unsubscribeSse: (() => void) | null = null
  let safetyTimer: ReturnType<typeof setInterval> | null = null

  function stop() {
    if (unsubscribeSse) {
      unsubscribeSse()
      unsubscribeSse = null
    }
    if (safetyTimer) {
      clearInterval(safetyTimer)
      safetyTimer = null
    }
    setSessions([])
  }

  async function refreshSessions(teamId: string) {
    try {
      const r = await client.listSessions(teamId)
      setSessions(r.sessions ?? [])
    } catch {
      // network errors are fine — SSE will recover on the next event
    }
  }

  createEffect(() => {
    stop()
    const w = ws()
    if (w.kind !== "team" || !w.id) return
    const teamId = w.id
    // Prime with a fetch so the badge renders immediately...
    void refreshSessions(teamId)
    // ...then subscribe to pushes.
    unsubscribeSse = client.subscribe(teamId, (ev) => {
      if (ev.type === "session_started" || ev.type === "session_ended" || ev.type === "session_heartbeat") {
        void refreshSessions(teamId)
      }
      if (ev.type === "team_deleted") {
        stop()
      }
    })
    // Safety net: if SSE dropped for whatever reason and didn't re-subscribe,
    // still refresh every 2 minutes so the UI eventually catches up.
    safetyTimer = setInterval(() => void refreshSessions(teamId), 120_000)
  })

  onMount(() => {
    const handler = (e: Event) => {
      setWs((e as CustomEvent<ActiveWorkspace>).detail ?? readActive())
    }
    window.addEventListener("workspace-changed", handler)
    onCleanup(() => {
      window.removeEventListener("workspace-changed", handler)
      stop()
    })
  })

  return (
    <Show when={ws().kind === "team" && sessions().length > 0}>
      <div data-component="team-presence-badge" title="Live sessions in this team">
        <span data-slot="dot" />
        <span data-slot="count">{sessions().length} live</span>
      </div>
    </Show>
  )
}
