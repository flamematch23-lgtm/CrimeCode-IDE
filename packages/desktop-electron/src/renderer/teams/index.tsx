import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { TeamLiveSession } from "../../preload/types"
import { WorkspaceSwitcher } from "./workspace-switcher"

export { WorkspaceSwitcher }

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
  const [ws, setWs] = createSignal<ActiveWorkspace>(readActive())
  const [sessions, setSessions] = createSignal<TeamLiveSession[]>([])
  const [err, setErr] = createSignal<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    setSessions([])
  }

  async function tick(teamId: string) {
    try {
      const r = await window.api.teams.listSessions(teamId)
      setSessions(r.sessions ?? [])
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  createEffect(() => {
    stop()
    const w = ws()
    if (w.kind !== "team" || !w.id) return
    const teamId = w.id
    void tick(teamId)
    pollTimer = setInterval(() => void tick(teamId), 15_000)
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
