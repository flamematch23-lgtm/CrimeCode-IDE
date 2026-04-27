import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import {
  getTeamsClient,
  readWebSession,
  signInWithAccount,
  type TeamSummary,
  logout as logoutSession,
} from "../../utils/teams-client"
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
  const [showLoginForm, setShowLoginForm] = createSignal(false)
  const [loginUsername, setLoginUsername] = createSignal("")
  const [loginPassword, setLoginPassword] = createSignal("")
  const [loginError, setLoginError] = createSignal<string | null>(null)
  const [loginSubmitting, setLoginSubmitting] = createSignal(false)
  // Popover lives in a Portal so it can never be clipped by a parent's
  // overflow or trapped behind another stacking context. Position is
  // measured from the trigger the moment we open.
  const [popoverPos, setPopoverPos] = createSignal<{ top: number; right: number } | null>(null)
  let triggerRef: HTMLButtonElement | undefined

  function close() {
    setOpen(false)
    setPopoverPos(null)
  }

  function toggleOpen() {
    if (open()) {
      close()
      return
    }
    if (!triggerRef) return
    const rect = triggerRef.getBoundingClientRect()
    setPopoverPos({
      top: rect.bottom + 6,
      right: Math.max(12, window.innerWidth - rect.right),
    })
    setOpen(true)
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

  function handleSignIn() {
    setShowLoginForm(true)
    setLoginError(null)
  }

  async function submitLogin(e: Event) {
    e.preventDefault()
    setLoginError(null)
    const user = loginUsername().trim()
    const pass = loginPassword()
    if (!user || !pass) {
      setLoginError("Inserisci username e password")
      return
    }
    setLoginSubmitting(true)
    try {
      const result = await signInWithAccount({ username: user, password: pass })
      if (result.status === "approved") {
        setShowLoginForm(false)
        // Reload to pick up the new session
        window.location.reload()
      } else {
        setLoginError("Account in attesa di approvazione admin")
      }
    } catch (err: any) {
      setLoginError(err?.message || "Errore di autenticazione")
    } finally {
      setLoginSubmitting(false)
    }
  }

  async function handleSignOut() {
    close()
    await logoutSession()
    window.location.reload()
  }

  // Close on outside click. The popover is portalled to document.body so
  // we need to accept clicks inside either the trigger OR the portaled
  // popover (marked with data-component="workspace-switcher-popover").
  function onDocClick(e: MouseEvent) {
    if (!open()) return
    const t = e.target as HTMLElement | null
    if (!t) return
    if (t.closest('[data-component="workspace-switcher"]')) return
    if (t.closest('[data-component="workspace-switcher-popover"]')) return
    close()
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
          ref={(el) => (triggerRef = el)}
          type="button"
          data-slot="trigger"
          onClick={toggleOpen}
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-label={`Current workspace: ${activeLabel().title}. Click to change.`}
        >
          <span data-slot="icon" aria-hidden="true">
            {activeLabel().icon}
          </span>
          <span data-slot="labels">
            <span data-slot="title">{activeLabel().title}</span>
            <span data-slot="subtitle">{activeLabel().subtitle}</span>
          </span>
          <span data-slot="chevron" aria-hidden="true">
            {open() ? "▲" : "▼"}
          </span>
        </button>
      </div>

      <Show when={open() && popoverPos()}>
        {(pos) => (
          <Portal>
            <div
              data-component="workspace-switcher-popover"
              data-slot="popover"
              role="menu"
              style={{
                position: "fixed",
                top: `${pos().top}px`,
                right: `${pos().right}px`,
                "z-index": 10000,
              }}
            >
              <Show
                when={account()}
                fallback={
                  <div data-slot="section">
                    <div data-slot="section-label">Account</div>
                    <Show
                      when={showLoginForm()}
                      fallback={
                        <div data-slot="not-signed-in">
                          <div data-slot="not-signed-in-title">Accedi per creare o unirti a un Team</div>
                          <div data-slot="not-signed-in-sub">
                            I Team Workspace ti permettono di condividere progetti e collaborare in tempo reale.
                          </div>
                          <button type="button" data-slot="signin" onClick={handleSignIn}>
                            <span data-slot="signin-icon" aria-hidden="true">
                              🔑
                            </span>
                            <span data-slot="signin-label">Accedi</span>
                          </button>
                        </div>
                      }
                    >
                      <form data-slot="login-form" onSubmit={submitLogin}>
                        <input
                          type="text"
                          placeholder="Username"
                          value={loginUsername()}
                          onInput={(e) => setLoginUsername(e.currentTarget.value)}
                          required
                        />
                        <input
                          type="password"
                          placeholder="Password"
                          value={loginPassword()}
                          onInput={(e) => setLoginPassword(e.currentTarget.value)}
                          required
                        />
                        <Show when={loginError()}>
                          <div data-slot="login-error">{loginError()}</div>
                        </Show>
                        <div data-slot="login-actions">
                          <button type="button" onClick={() => setShowLoginForm(false)}>
                            Annulla
                          </button>
                          <button type="submit" disabled={loginSubmitting()}>
                            {loginSubmitting() ? "Caricamento..." : "Accedi"}
                          </button>
                        </div>
                      </form>
                    </Show>
                  </div>
                }
              >
                <div data-slot="section">
                  <div data-slot="section-label">Personale</div>
                  <button
                    type="button"
                    data-slot="item"
                    data-active={active().kind === "personal"}
                    onClick={onPickPersonal}
                  >
                    <span data-slot="item-icon" aria-hidden="true">
                      👤
                    </span>
                    <span data-slot="item-labels">
                      <span data-slot="item-title">Workspace personale</span>
                      <span data-slot="item-subtitle">Solo tu — file e progetti privati</span>
                    </span>
                    <Show when={active().kind === "personal"}>
                      <span data-slot="check" aria-label="Workspace attivo">
                        ✓
                      </span>
                    </Show>
                  </button>
                  <div data-slot="account-id" title={(account() as { customer_id?: string } | null)?.customer_id ?? ""}>
                    <span data-slot="account-id-label">ID</span>
                    <code>{(account() as { customer_id?: string } | null)?.customer_id?.slice(0, 18)}</code>
                  </div>
                  <button type="button" data-slot="signout" onClick={handleSignOut}>
                    <span data-slot="signout-icon" aria-hidden="true">
                      🚪
                    </span>
                    <span data-slot="signout-label">Esci</span>
                  </button>
                </div>

                <div data-slot="section">
                  <div data-slot="section-label">
                    <span>Team Workspace</span>
                    <span data-slot="section-hint">Condivisi · in tempo reale</span>
                  </div>

                  <Show
                    when={(teams() ?? []).length > 0}
                    fallback={
                      <div data-slot="teams-empty">
                        <div data-slot="teams-empty-icon" aria-hidden="true">
                          👥
                        </div>
                        <div data-slot="teams-empty-title">Non sei ancora in un Team</div>
                        <div data-slot="teams-empty-sub">
                          Crea un Team Workspace per condividere progetti, vedere i cursori dei colleghi in tempo reale
                          e lavorare insieme.
                        </div>
                      </div>
                    }
                  >
                    <For each={teams() ?? []}>
                      {(team) => (
                        <div data-slot="item-row" data-active={active().kind === "team" && active().id === team.id}>
                          <button
                            type="button"
                            data-slot="item"
                            data-active={active().kind === "team" && active().id === team.id}
                            onClick={() => onPickTeam(team)}
                          >
                            <span data-slot="item-icon" aria-hidden="true">
                              👥
                            </span>
                            <span data-slot="item-labels">
                              <span data-slot="item-title">
                                {team.name}
                                {team.role === "owner" && <span data-slot="badge-owner">👑 Owner</span>}
                              </span>
                              <span data-slot="item-subtitle">
                                {team.member_count ?? 1} {team.member_count === 1 ? "membro" : "membri"} · Workspace
                                condiviso
                              </span>
                            </span>
                            <Show when={active().kind === "team" && active().id === team.id}>
                              <span data-slot="check" aria-label="Workspace attivo">
                                ✓
                              </span>
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
                            aria-label={`Gestisci ${team.name}`}
                            title="Gestisci membri e impostazioni"
                          >
                            <span aria-hidden="true">⚙</span>
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>

                  <button
                    type="button"
                    data-slot="create"
                    onClick={() => {
                      setShowCreate(true)
                      close()
                    }}
                  >
                    <span data-slot="create-icon" aria-hidden="true">
                      +
                    </span>
                    <span data-slot="create-labels">
                      <span data-slot="create-title">Crea Team Workspace</span>
                      <span data-slot="create-sub">Condividi progetti con il tuo team</span>
                    </span>
                  </button>
                </div>
              </Show>
            </div>
          </Portal>
        )}
      </Show>

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
