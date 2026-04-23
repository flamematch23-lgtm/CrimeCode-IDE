import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { getTeamsClient } from "@opencode-ai/app/utils/teams-client"

/**
 * Live cursor overlay for a team workspace.
 *
 * Publishes our own cursor position at ~10 Hz while we're hosting a live
 * session, and renders a coloured dot + username for every incoming
 * cursor_moved event from other members. Each remote cursor fades out
 * after 4 seconds of no update.
 *
 * The overlay is self-mounting: it watches localStorage["client.active-workspace"]
 * (same signal the workspace switcher uses) so it enables automatically
 * when you switch INTO a team workspace, and disables in Personal.
 */

interface RemoteCursor {
  customer_id: string
  x: number
  y: number
  label: string | null
  lastSeen: number
  color: string
}

// Deterministic colour from the customer id so each user gets the same
// hue every time (via fraction of FNV-1a hash over HSL wheel).
function colorFor(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const hue = ((h >>> 0) % 360 + 360) % 360
  return `hsl(${hue}, 85%, 58%)`
}

function readActiveTeamId(): string | null {
  try {
    const raw = localStorage.getItem("client.active-workspace")
    if (!raw) return null
    const p = JSON.parse(raw)
    if (p?.kind === "team" && typeof p.id === "string") return p.id
  } catch {
    /* ignore */
  }
  return null
}

function readActiveSessionId(): string | null {
  try {
    return localStorage.getItem("client.active-team-session")
  } catch {
    return null
  }
}

export function LiveCursors() {
  const client = getTeamsClient()
  const [teamId, setTeamId] = createSignal<string | null>(readActiveTeamId())
  const [sessionId, setSessionId] = createSignal<string | null>(readActiveSessionId())
  const [remote, setRemote] = createSignal<Record<string, RemoteCursor>>({})

  let unsub: (() => void) | null = null
  let gcTimer: ReturnType<typeof setInterval> | null = null
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  let lastPublish = 0
  let pendingCoords: { x: number; y: number } | null = null

  function stop() {
    if (unsub) {
      unsub()
      unsub = null
    }
    if (gcTimer) {
      clearInterval(gcTimer)
      gcTimer = null
    }
    setRemote({})
  }

  createEffect(() => {
    stop()
    const tid = teamId()
    if (!tid) return
    unsub = client.subscribe(tid, (ev) => {
      if (ev.type !== "cursor_moved") return
      if (!ev.customer_id || typeof ev.x !== "number" || typeof ev.y !== "number") return
      setRemote((prev) => ({
        ...prev,
        [ev.customer_id as string]: {
          customer_id: ev.customer_id as string,
          x: ev.x as number,
          y: ev.y as number,
          label: (ev.label as string | undefined) ?? null,
          lastSeen: Date.now(),
          color: colorFor(ev.customer_id as string),
        },
      }))
    })
    // Fade out stale cursors after 4s of silence.
    gcTimer = setInterval(() => {
      const cutoff = Date.now() - 4_000
      setRemote((prev) => {
        const next: Record<string, RemoteCursor> = {}
        let changed = false
        for (const [k, v] of Object.entries(prev)) {
          if (v.lastSeen >= cutoff) next[k] = v
          else changed = true
        }
        return changed ? next : prev
      })
    }, 1_000)
  })

  onMount(() => {
    const onWsChange = () => {
      setTeamId(readActiveTeamId())
      setSessionId(readActiveSessionId())
    }
    window.addEventListener("workspace-changed", onWsChange)
    window.addEventListener("team-session-changed", onWsChange)

    // Throttled publish loop: remember the last mouse position and ship at
    // most every 100 ms (10 Hz) so we don't flood the SSE bus.
    const onMouseMove = (e: MouseEvent) => {
      const tid = teamId()
      const sid = sessionId()
      if (!tid || !sid) return
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      pendingCoords = { x: e.clientX / vw, y: e.clientY / vh }
      const now = Date.now()
      const since = now - lastPublish
      if (since >= 100) {
        lastPublish = now
        const { x, y } = pendingCoords
        pendingCoords = null
        void client.publishCursor(tid, sid, x, y).catch(() => undefined)
      } else if (!publishTimer) {
        publishTimer = setTimeout(() => {
          publishTimer = null
          if (!pendingCoords) return
          lastPublish = Date.now()
          const { x, y } = pendingCoords
          pendingCoords = null
          void client
            .publishCursor(teamId() ?? "", sessionId() ?? "", x, y)
            .catch(() => undefined)
        }, 100 - since)
      }
    }
    window.addEventListener("mousemove", onMouseMove, { passive: true })

    onCleanup(() => {
      window.removeEventListener("workspace-changed", onWsChange)
      window.removeEventListener("team-session-changed", onWsChange)
      window.removeEventListener("mousemove", onMouseMove)
      if (publishTimer) clearTimeout(publishTimer)
      stop()
    })
  })

  return (
    <Show when={teamId() && Object.keys(remote()).length > 0}>
      <div data-component="live-cursors" aria-hidden="true">
        <For each={Object.values(remote())}>
          {(cursor) => (
            <div
              data-slot="cursor"
              style={{
                left: (cursor.x * 100).toFixed(2) + "%",
                top: (cursor.y * 100).toFixed(2) + "%",
                "--cursor-color": cursor.color,
              } as never}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path
                  d="M2 2L16 8L9 10L7 16L2 2Z"
                  fill={cursor.color}
                  stroke="#07070a"
                  stroke-width="1.2"
                  stroke-linejoin="round"
                />
              </svg>
              <span data-slot="label">{cursor.label ?? cursor.customer_id.slice(0, 8)}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
