/**
 * TeamPresencePanel — real-time collaboration popover for a team workspace.
 *
 * Shows the live state of the team in real time:
 *  - "Sei in una sessione live" / "Vai live" toggle
 *  - one row per team member with a live/offline state, an avatar, and
 *    "Cursore attivo" sub-text when they've moved their mouse recently
 *  - an automatic refresh that piggybacks on the SSE event stream so any
 *    member's join/leave/cursor activity is reflected in <100 ms
 *
 * State is owned by `useTeamPresence`, which is also wired into the
 * compact `TeamPresenceBadge` rendered in the chrome — so the pill
 * count and this panel never disagree.
 */
import { createMemo, createSignal, For, Show, onMount, onCleanup, createEffect } from "solid-js"
import {
  getActiveTeamSession,
  joinOrStartTeamSession,
  leaveActiveTeamSession,
  setFollowedCustomer,
  getFollowedCustomer,
  fetchSharedState,
  type SharedWorkspaceState,
} from "../../utils/team-session"
import { useTeamPresence, type MemberPresence } from "./use-team-presence"
import type { TeamMember } from "../../utils/teams-client"

function colorFor(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const hue = ((h >>> 0) % 360 + 360) % 360
  return `hsl(${hue}, 75%, 56%)`
}

function initials(member: TeamMember): string {
  const candidate = member.display ?? member.telegram ?? member.customer_id
  return (
    candidate
      .replace(/^@/, "")
      .split(/[\s._-]+/)
      .map((s) => s[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || candidate.slice(0, 2).toUpperCase()
  )
}

function memberLabel(p: MemberPresence): string {
  return p.member.display ?? p.member.telegram ?? p.member.customer_id.slice(0, 12)
}

function timeAgo(at: number | null): string {
  if (!at) return ""
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 5) return "ora"
  if (seconds < 60) return `${seconds}s fa`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m fa`
  const hours = Math.round(minutes / 60)
  return `${hours}h fa`
}

export function TeamPresencePanel(props: { teamId: string; selfCustomerId?: string | null }) {
  const teamIdAccessor = () => props.teamId
  const { presence, liveCount, totalMembers, refreshSessions, getStateForHost } =
    useTeamPresence(teamIdAccessor)

  const [activeSession, setActiveSession] = createSignal<{ teamId: string; sessionId: string } | null>(
    getActiveTeamSession(),
  )
  const [busy, setBusy] = createSignal(false)
  const [following, setFollowing] = createSignal<string | null>(getFollowedCustomer())

  onMount(() => {
    const onSessionChange = () => setActiveSession(getActiveTeamSession())
    const onFollowChange = (e: Event) => setFollowing((e as CustomEvent<string | null>).detail ?? null)
    window.addEventListener("team-session-changed", onSessionChange)
    window.addEventListener("team-following-changed", onFollowChange)
    onCleanup(() => {
      window.removeEventListener("team-session-changed", onSessionChange)
      window.removeEventListener("team-following-changed", onFollowChange)
    })
  })

  // When the user starts following a member, hydrate the shared state
  // immediately by fetching the latest snapshot from the server. This
  // closes the gap between "click follow" and "first state push arrives"
  // — without the fetch the workspace info would stay blank up to ~25 s.
  createEffect(() => {
    const cid = following()
    if (!cid) return
    const sess = presence().find((p) => p.member.customer_id === cid)?.session
    if (!sess) return
    void fetchSharedState(props.teamId, sess.id).catch(() => undefined)
  })

  function startFollow(customerId: string) {
    setFollowedCustomer(customerId)
    setFollowing(customerId)
  }
  function stopFollow() {
    setFollowedCustomer(null)
    setFollowing(null)
  }

  function describeState(s: SharedWorkspaceState | null | undefined): string | null {
    if (!s) return null
    const parts: string[] = []
    if (s.title) parts.push(s.title)
    if (s.project_path) parts.push(`📁 ${shortPath(s.project_path)}`)
    if (s.active_file) parts.push(`📄 ${s.active_file}`)
    return parts.length > 0 ? parts.join(" · ") : null
  }

  function shortPath(p: string): string {
    if (p.length <= 36) return p
    const parts = p.split(/[\\/]/)
    if (parts.length <= 2) return "…" + p.slice(-32)
    return parts.slice(-2).join("/")
  }

  const followingMember = createMemo(() => {
    const cid = following()
    if (!cid) return null
    return presence().find((p) => p.member.customer_id === cid) ?? null
  })

  const isInSession = createMemo(() => activeSession()?.teamId === props.teamId)
  const sortedPresence = createMemo<MemberPresence[]>(() => {
    return [...presence()].sort((a, b) => {
      // self first → live → recently seen → offline
      const aSelf = a.member.customer_id === props.selfCustomerId ? 0 : 1
      const bSelf = b.member.customer_id === props.selfCustomerId ? 0 : 1
      if (aSelf !== bSelf) return aSelf - bSelf
      const aLive = a.state === "live" ? 0 : 1
      const bLive = b.state === "live" ? 0 : 1
      if (aLive !== bLive) return aLive - bLive
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    })
  })

  const onJoin = async () => {
    setBusy(true)
    try {
      await joinOrStartTeamSession(props.teamId)
      setActiveSession(getActiveTeamSession())
      refreshSessions()
    } finally {
      setBusy(false)
    }
  }

  const onLeave = async () => {
    setBusy(true)
    try {
      await leaveActiveTeamSession()
      setActiveSession(getActiveTeamSession())
      refreshSessions()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-component="team-presence-panel">
      <div data-slot="header">
        <div data-slot="title-row">
          <span data-slot="status-dot" data-state={isInSession() ? "live" : "idle"} aria-hidden="true" />
          <span data-slot="title">{isInSession() ? "Sei in una sessione live" : "Sessione live non attiva"}</span>
          <span data-slot="count">
            {liveCount()} di {totalMembers()} online
          </span>
        </div>
        <div data-slot="action-row">
          <Show
            when={isInSession()}
            fallback={
              <button data-slot="primary" type="button" onClick={onJoin} disabled={busy()}>
                {busy() ? "Avvio…" : "Vai live"}
              </button>
            }
          >
            <button data-slot="secondary" type="button" onClick={onLeave} disabled={busy()}>
              Esci dalla sessione
            </button>
          </Show>
        </div>
      </div>

      <Show when={followingMember()}>
        {(m) => {
          const memberState = () =>
            (getStateForHost(m().member.customer_id) as SharedWorkspaceState | null) ?? null
          const desc = () => describeState(memberState())
          return (
            <div data-slot="follow-banner">
              <span data-slot="follow-tag">SEGUI</span>
              <span data-slot="follow-target">
                <span data-slot="follow-name">{memberLabel(m())}</span>
                <Show when={desc()}>
                  <span data-slot="follow-desc">{desc()}</span>
                </Show>
              </span>
              <button data-slot="follow-stop" type="button" onClick={stopFollow}>
                Smetti
              </button>
            </div>
          )
        }}
      </Show>

      <div data-slot="member-list" aria-live="polite">
        <Show when={sortedPresence().length > 0} fallback={<div data-slot="empty">Nessun membro nel team.</div>}>
          <For each={sortedPresence()}>
            {(p) => {
              const isSelf = p.member.customer_id === props.selfCustomerId
              const color = colorFor(p.member.customer_id)
              const ini = initials(p.member)
              const isFollowed = () => following() === p.member.customer_id
              const memberWorkspace = () =>
                (getStateForHost(p.member.customer_id) as SharedWorkspaceState | null) ?? null
              const desc = () => describeState(memberWorkspace())
              return (
                <div data-slot="member" data-state={p.state} data-self={isSelf ? "true" : "false"}>
                  <div data-slot="avatar" style={{ "--avatar-color": color } as never}>
                    <span data-slot="avatar-initials">{ini}</span>
                    <Show when={p.state === "live"}>
                      <span data-slot="avatar-pulse" aria-hidden="true" />
                    </Show>
                  </div>
                  <div data-slot="member-meta">
                    <div data-slot="member-name">
                      {memberLabel(p)}
                      <Show when={isSelf}>
                        <span data-slot="self-tag">Tu</span>
                      </Show>
                      <Show when={p.member.role === "owner"}>
                        <span data-slot="role-tag">Owner</span>
                      </Show>
                    </div>
                    <div data-slot="member-status">
                      <Show
                        when={p.state === "live"}
                        fallback={
                          <span data-slot="state-text" data-state="offline">
                            {p.lastSeenAt ? `Visto ${timeAgo(p.lastSeenAt)}` : "Offline"}
                          </span>
                        }
                      >
                        <span data-slot="state-text" data-state="live">
                          {p.cursorAt && Date.now() - p.cursorAt < 4000
                            ? "Cursore attivo · live"
                            : p.session
                              ? "In sessione · live"
                              : "Live ora"}
                        </span>
                      </Show>
                    </div>
                    <Show when={p.state === "live" && desc()}>
                      <div data-slot="member-workspace">{desc()}</div>
                    </Show>
                  </div>
                  <Show when={p.state === "live" && !isSelf}>
                    <Show
                      when={isFollowed()}
                      fallback={
                        <button
                          data-slot="follow-btn"
                          type="button"
                          onClick={() => startFollow(p.member.customer_id)}
                          title="Segui questo membro: vedi project / file / sessione che sta usando"
                        >
                          Segui
                        </button>
                      }
                    >
                      <button data-slot="follow-btn" data-active="true" type="button" onClick={stopFollow}>
                        ✓ Stai seguendo
                      </button>
                    </Show>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      <Show when={!isInSession()}>
        <div data-slot="footer-hint">
          Quando vai live i tuoi cursori e movimenti diventano visibili agli altri membri del team. La condivisione si
          ferma se cambi workspace o chiudi l'app.
        </div>
      </Show>
    </div>
  )
}
