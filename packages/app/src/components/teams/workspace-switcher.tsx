import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { getTeamsClient, readWebSession, type TeamSummary } from "../../utils/teams-client"
import { CreateTeamDialog } from "./create-team-dialog"
import { ManageTeamDialog } from "./manage-team-dialog"

const LOCAL_WORKSPACE_KEY = "client.active-workspace"
const DEFAULT_PERSONAL = { kind: "personal", id: null } as const

type ActiveWorkspace = { kind: "personal"; id: null } | { kind: "team"; id: string }

function readActive(): ActiveWorkspace {
  try {
    const raw = localStorage.getItem(LOCAL_WORKSPACE_KEY)
    if (!raw) return DEFAULT_PERSONAL
    const parsed = JSON.parse(raw)
    if (parsed?.kind === "team" && typeof parsed.id === "string") return parsed
    return DEFAULT_PERSONAL
  } catch {
    return DEFAULT_PERSONAL
  }
}

function writeActive(ws: ActiveWorkspace): void {
  localStorage.setItem(LOCAL_WORKSPACE_KEY, JSON.stringify(ws))
  window.dispatchEvent(new CustomEvent("workspace-changed", { detail: ws }))
}

export function WorkspaceSwitcher() {
  const client = getTeamsClient()
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal<ActiveWorkspace>(readActive())
  const [account] = createResource(async () => {
    // Desktop: window.api.account.get is authoritative.
    // Web: fall back to the localStorage session.
    const api = (window as unknown as { api?: { account?: { get: () => Promise<unknown> } } }).api
    if (api?.account?.get) return api.account.get()
    return readWebSession()
  })
  const [teams, { refetch: refetchTeams }] = createResource(async () => {
    const acc = await account()
    if (!acc) return []
    const r = await client.list()
    return r.teams
  })
  const [showCreate, setShowCreate] = createSignal(false)
  const [manageId, setManageId] = createSignal<string | null>(null)

  function close() {
    setOpen(false)
  }

  function onPickPersonal() {
    const w: ActiveWorkspace = { kind: "personal", id: null }
    setActive(w)
    writeActive(w)
    close()
  }

  function onPickTeam(team: TeamSummary) {
    const w: ActiveWorkspace = { kind: "team", id: team.id }
    setActive(w)
    writeActive(w)
    close()
  }

  // Close on outside click.
  function onDocClick(e: MouseEvent) {
    if (!open()) return
    const t = e.target as HTMLElement | null
    if (!t || !t.closest('[data-component="workspace-switcher"]')) setOpen(false)
  }

  createEffect(() => {
    if (open()) document.addEventListener("mousedown", onDocClick)
    else document.removeEventListener("mousedown", onDocClick)
  })
  onCleanup(() => document.removeEventListener("mousedown", onDocClick))

  const activeLabel = () => {
    if (active().kind === "personal") return { title: "Personal", subtitle: "Only you", icon: "👤" }
    const t = teams()?.find((t) => t.id === active().id)
    return t
      ? { title: t.name, subtitle: "Team workspace", icon: "👥" }
      : { title: "Personal", subtitle: "Only you", icon: "👤" }
  }

  return (
    <>
      <div data-component="workspace-switcher">
        <button
          data-slot="trigger"
          onClick={() => setOpen(!open())}
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-label={`Current workspace: ${activeLabel().title}. Click to change.`}
        >
          <span data-slot="icon" aria-hidden="true">{activeLabel().icon}</span>
          <span data-slot="labels">
            <span data-slot="title">{activeLabel().title}</span>
            <span data-slot="subtitle">{activeLabel().subtitle}</span>
          </span>
          <span data-slot="chevron" aria-hidden="true">{open() ? "▲" : "▼"}</span>
        </button>

        <Show when={open()}>
          <div data-slot="popover" role="menu">
            <Show when={account()} fallback={<div data-slot="empty">Sign in to create or join teams.</div>}>
              <div data-slot="section-label">PERSONAL</div>
              <button
                data-slot="item"
                data-active={active().kind === "personal"}
                onClick={onPickPersonal}
              >
                <span data-slot="item-icon" aria-hidden="true">👤</span>
                <span data-slot="item-labels">
                  <span data-slot="item-title">
                    {(account() as { customer_id?: string } | null)?.customer_id?.slice(0, 16)}
                  </span>
                  <span data-slot="item-subtitle">Your private workspace</span>
                </span>
                <Show when={active().kind === "personal"}>
                  <span data-slot="check" aria-label="Currently active">✓</span>
                </Show>
              </button>

              <Show when={(teams() ?? []).length > 0}>
                <div data-slot="section-label">TEAMS</div>
                <For each={teams() ?? []}>
                  {(team) => (
                    <div
                      data-slot="item-row"
                      data-active={active().kind === "team" && active().id === team.id}
                    >
                      <button
                        type="button"
                        data-slot="item"
                        data-active={active().kind === "team" && active().id === team.id}
                        onClick={() => onPickTeam(team)}
                      >
                        <span data-slot="item-icon" aria-hidden="true">👥</span>
                        <span data-slot="item-labels">
                          <span data-slot="item-title">
                            {team.name}
                            {team.role === "owner" && <span data-slot="badge-owner">👑 Owner</span>}
                          </span>
                          <span data-slot="item-subtitle">
                            {team.member_count ?? 1} {team.member_count === 1 ? "member" : "members"}
                          </span>
                        </span>
                        <Show when={active().kind === "team" && active().id === team.id}>
                          <span data-slot="check" aria-label="Currently active">✓</span>
                        </Show>
                      </button>
                      <button
                        type="button"
                        data-slot="gear"
                        onClick={(e) => {
                          e.stopPropagation()
                          setManageId(team.id)
                          close()
                        }}
                        aria-label={`Manage team ${team.name}`}
                      >
                        <span aria-hidden="true">⚙</span>
                      </button>
                    </div>
                  )}
                </For>
              </Show>

              <button
                data-slot="create"
                onClick={() => {
                  setShowCreate(true)
                  close()
                }}
              >
                ⊕ Create Team
              </button>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={showCreate()}>
        <CreateTeamDialog
          onClose={() => setShowCreate(false)}
          onCreated={async (team) => {
            setShowCreate(false)
            await refetchTeams()
            onPickTeam(team)
          }}
        />
      </Show>
      <Show when={manageId()}>
        {(id) => (
          <ManageTeamDialog
            teamId={id()}
            onClose={() => setManageId(null)}
            onDeleted={async () => {
              setManageId(null)
              await refetchTeams()
              onPickPersonal()
            }}
          />
        )}
      </Show>
    </>
  )
}
