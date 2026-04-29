import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { LiveCursors } from "./live-cursors"
import { useTeamPresence } from "@opencode-ai/app/components/teams/use-team-presence"
import { TeamPresencePanel } from "@opencode-ai/app/components/teams/team-presence-panel"
import { TeamChatPanel } from "@opencode-ai/app/components/teams/team-chat-panel"
import { getTeamsClient, type TeamEvent } from "@opencode-ai/app/utils/teams-client"

export { WorkspaceSwitcher, LiveCursors, TeamPresencePanel, TeamChatPanel }
// TeamChatTrigger and TeamPresenceBadge are exported below as named functions
// declared further down in this module — Solid resolves the references at
// import-time the same way it does for the existing exports.

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

function readSelfCustomerId(): string | null {
  try {
    const raw = localStorage.getItem("crimecode.session")
    if (!raw) return null
    const parsed = JSON.parse(raw) as { customer_id?: string }
    return parsed.customer_id ?? null
  } catch {
    return null
  }
}

/**
 * Compact "N LIVE" pill rendered next to the workspace switcher.
 *
 * Counts UNIQUE MEMBERS that are currently live (active session
 * heartbeat within 90 s OR cursor moved within the last 8 s), not raw
 * session rows.
 *
 * Click opens a popover with the full TeamPresencePanel (member list +
 * join/leave button + avatars). Both surfaces share `useTeamPresence`
 * so the count never desyncs.
 *
 * Re-renders are driven by the SSE stream (bridged through preload IPC,
 * see preload/index.ts and main/ipc.ts) plus a 1 Hz internal tick that
 * lets stale members fade out the moment their freshness window expires.
 */
export function TeamPresenceBadge() {
  const [ws, setWs] = createSignal<ActiveWorkspace>(readActive())
  const [open, setOpen] = createSignal(false)
  const [pos, setPos] = createSignal<{ top: number; right: number } | null>(null)
  const [selfCid, setSelfCid] = createSignal<string | null>(readSelfCustomerId())

  let triggerRef: HTMLButtonElement | undefined

  onMount(() => {
    const handler = (e: Event) => {
      setWs((e as CustomEvent<ActiveWorkspace>).detail ?? readActive())
    }
    window.addEventListener("workspace-changed", handler)
    onCleanup(() => window.removeEventListener("workspace-changed", handler))
    // Refresh self customer id on auth changes — relevant if the user
    // logs out and back in while the badge is mounted.
    const onStorage = () => setSelfCid(readSelfCustomerId())
    window.addEventListener("storage", onStorage)
    onCleanup(() => window.removeEventListener("storage", onStorage))
  })

  // Pass a reactive accessor so the hook re-wires when the user switches teams.
  const teamId = () => (ws().kind === "team" ? ws().id : null)
  const { liveCount, totalMembers, presence } = useTeamPresence(teamId)

  function close() {
    setOpen(false)
    setPos(null)
  }

  function toggleOpen() {
    if (open()) {
      close()
      return
    }
    if (!triggerRef) return
    const rect = triggerRef.getBoundingClientRect()
    setPos({
      top: rect.bottom + 6,
      right: Math.max(12, window.innerWidth - rect.right),
    })
    setOpen(true)
  }

  // Close popover on outside click
  createEffect(() => {
    if (!open()) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-component="team-presence-badge"]')) return
      if (t.closest('[data-component="team-presence-panel"]')) return
      close()
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  return (
    <Show when={ws().kind === "team" && liveCount() > 0}>
      <button
        ref={(el) => (triggerRef = el)}
        type="button"
        data-component="team-presence-badge"
        title={`${liveCount()} di ${totalMembers()} membri in live ora — clicca per dettagli`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-live="polite"
        onClick={toggleOpen}
      >
        <span data-slot="dot" />
        <span data-slot="count">{liveCount()} LIVE</span>
        <Show when={totalMembers() > liveCount()}>
          <span data-slot="total">/ {totalMembers()}</span>
        </Show>
        <span data-slot="avatars">
          {presence()
            .filter((p: { state: string }) => p.state === "live")
            .slice(0, 4)
            .map((p: { member: { display: string | null; telegram: string | null; customer_id: string } }) => (
              <span
                data-slot="avatar"
                title={p.member.display ?? p.member.telegram ?? p.member.customer_id}
                style={{
                  "--avatar-color": stableColor(p.member.customer_id),
                } as never}
              >
                {initialsOf(p.member.display ?? p.member.telegram ?? p.member.customer_id)}
              </span>
            ))}
        </span>
      </button>

      <Show when={open() && pos() && ws().kind === "team" && ws().id ? pos() : null}>
        {(p) => (
          <Portal>
            <div
              role="dialog"
              aria-label="Membri del team in live"
              style={{
                position: "fixed",
                top: `${p().top}px`,
                right: `${p().right}px`,
                "z-index": 10001,
              }}
            >
              <TeamPresencePanel teamId={ws().id as string} selfCustomerId={selfCid()} />
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  )
}

/**
 * Floating chat trigger — pill rendered next to the workspace switcher
 * that opens the TeamChatPanel popover. Shows an unread-badge with the
 * count of `chat_message` events received while the panel was closed.
 *
 * Uses the same SSE bridge as everything else (preload IPC -> main fetch
 * stream -> renderer event), so messages appear instantly without
 * polling.
 */
export function TeamChatTrigger() {
  const [ws, setWs] = createSignal<ActiveWorkspace>(readActive())
  const [open, setOpen] = createSignal(false)
  const [unread, setUnread] = createSignal(0)
  const [pos, setPos] = createSignal<{ top: number; right: number } | null>(null)
  const [selfCid, setSelfCid] = createSignal<string | null>(readSelfCustomerId())
  let triggerRef: HTMLButtonElement | undefined

  onMount(() => {
    const wsHandler = (e: Event) => setWs((e as CustomEvent<ActiveWorkspace>).detail ?? readActive())
    const storageHandler = () => setSelfCid(readSelfCustomerId())
    window.addEventListener("workspace-changed", wsHandler)
    window.addEventListener("storage", storageHandler)
    onCleanup(() => {
      window.removeEventListener("workspace-changed", wsHandler)
      window.removeEventListener("storage", storageHandler)
    })
  })

  // Listen to chat_message globally to bump the unread badge.
  createEffect(() => {
    const w = ws()
    if (w.kind !== "team" || !w.id) {
      setUnread(0)
      return
    }
    const teamId = w.id
    const client = getTeamsClient()
    const unsub = client.subscribe(teamId, (ev: TeamEvent) => {
      if (ev.type !== "chat_message") return
      // Don't count our own messages
      if (ev.customer_id && ev.customer_id === selfCid()) return
      if (open()) return
      setUnread((n) => n + 1)
    })
    onCleanup(unsub)
  })

  // Reset unread when the panel opens
  createEffect(() => {
    if (open()) setUnread(0)
  })

  function close() {
    setOpen(false)
    setPos(null)
  }

  function toggle() {
    if (open()) {
      close()
      return
    }
    if (!triggerRef) return
    const rect = triggerRef.getBoundingClientRect()
    setPos({ top: rect.bottom + 6, right: Math.max(12, window.innerWidth - rect.right) })
    setOpen(true)
  }

  // Outside click closes the panel
  createEffect(() => {
    if (!open()) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-component="team-chat-panel"]')) return
      if (t.closest('[data-component="team-chat-trigger"]')) return
      close()
    }
    document.addEventListener("mousedown", onDoc)
    onCleanup(() => document.removeEventListener("mousedown", onDoc))
  })

  return (
    <Show when={ws().kind === "team" && ws().id}>
      <button
        ref={(el) => (triggerRef = el)}
        type="button"
        data-component="team-chat-trigger"
        title="Apri chat del team"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={toggle}
      >
        <span aria-hidden="true">💬</span>
        <span>Chat</span>
        <Show when={unread() > 0}>
          <span data-slot="badge">{unread() > 99 ? "99+" : unread()}</span>
        </Show>
      </button>
      <Show when={open() && ws().id ? pos() : null}>
        {(p) => (
          <Portal>
            <div
              role="dialog"
              aria-label="Chat del team"
              style={{
                position: "fixed",
                top: `${p().top}px`,
                right: `${p().right}px`,
                "z-index": 10001,
              }}
            >
              <TeamChatPanel teamId={ws().id as string} selfCustomerId={selfCid()} />
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  )
}

function stableColor(id: string): string {
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
