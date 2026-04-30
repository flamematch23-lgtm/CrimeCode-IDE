import { createSignal, createMemo, Show, For, onMount, onCleanup } from "solid-js"
import { useTeamPresence, type MemberPresence } from "./use-team-presence"

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

function colorFor(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const hue = ((h >>> 0) % 360 + 360) % 360
  return `hsl(${hue}, 75%, 56%)`
}

function initialsOf(name: string): string {
  return (
    name
      .replace(/^@/, "")
      .split(/[\s._-]+/)
      .map((s) => s[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || name.slice(0, 2).toUpperCase()
  )
}

function memberLabel(p: MemberPresence): string {
  return p.member.display ?? p.member.telegram ?? p.member.customer_id.slice(0, 12)
}

export function TeamSidebarBanner() {
  const [ws, setWs] = createSignal<ActiveWorkspace>(readActive())

  onMount(() => {
    const handler = (e: Event) => setWs((e as CustomEvent<ActiveWorkspace>).detail ?? readActive())
    window.addEventListener("workspace-changed", handler)
    onCleanup(() => window.removeEventListener("workspace-changed", handler))
  })

  const teamId = () => (ws().kind === "team" ? ws().id : null)
  const { detail, presence, liveCount, totalMembers } = useTeamPresence(teamId)

  const teamName = createMemo(() => detail()?.team?.name ?? null)

  const liveMembers = createMemo(() =>
    presence()
      .filter((p) => p.state === "live")
      .slice(0, 6),
  )

  // Only render once we've actually loaded the team detail. Without this
  // guard the banner flashes "Team / 0 / 0 online" between workspace switch
  // and the detail() resource resolving — and lingers showing stale data if
  // the team was deleted server-side.
  return (
    <Show when={ws().kind === "team" && teamId() && teamName()}>
      <div data-component="team-sidebar-banner">
        <div data-slot="team-header">
          <span data-slot="team-icon" aria-hidden="true">
            <span data-slot="team-dot" />
          </span>
          <div data-slot="team-info">
            <span data-slot="team-name">{teamName()}</span>
            <span data-slot="team-meta">
              {liveCount()} / {totalMembers()} online
            </span>
          </div>
        </div>

        <Show when={liveMembers().length > 0}>
          <div data-slot="live-members">
            <For each={liveMembers()}>
              {(p) => {
                const color = colorFor(p.member.customer_id)
                const label = memberLabel(p)
                return (
                  <div data-slot="live-member" title={label}>
                    <span
                      data-slot="live-avatar"
                      style={{ "--avatar-color": color } as never}
                    >
                      {initialsOf(label)}
                    </span>
                    <span data-slot="live-name">{label}</span>
                    <span data-slot="live-status">
                      {p.cursorAt && Date.now() - p.cursorAt < 4000
                        ? "attivo"
                        : "live"}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={liveMembers().length === 0}>
          <div data-slot="no-live">Nessun membro live al momento</div>
        </Show>
      </div>
    </Show>
  )
}
