import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import {
  getTeamsClient,
  readWebSession,
  signInWithAccount,
  signUpWithAccount,
  fetchApprovalStatus,
  writeWebSession,
  type TeamSummary,
  logout as logoutSession,
} from "../../utils/teams-client"
import { CreateTeamDialog } from "./create-team-dialog"
import { ManageTeamDialog } from "./manage-team-dialog"
import { joinOrStartTeamSession, leaveActiveTeamSession } from "../../utils/team-session"

const LOCAL_WORKSPACE_KEY = "client.active-workspace"
const DEFAULT_PERSONAL = { kind: "personal", id: null } as const
const API_BASE = "https://api.crimecode.cc"

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

async function startTgAuth(): Promise<{ pin: string; bot_url: string; expires_at: number }> {
  const isDesktop = typeof (window as any).api?.account?.startSignIn === "function"
  if (isDesktop) return (window as any).api.account.startSignIn()
  const res = await fetch(`${API_BASE}/license/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_label: navigator.userAgent.slice(0, 80) }),
  })
  if (!res.ok) throw new Error(`auth/start ${res.status}`)
  return res.json()
}

async function pollTgAuth(pin: string): Promise<Record<string, unknown>> {
  const isDesktop = typeof (window as any).api?.account?.pollSignIn === "function"
  if (isDesktop) {
    const session = await (window as any).api.account.pollSignIn(pin)
    if (session)
      return { status: "ok", token: session.token, customer_id: session.customer_id, exp: session.expires_at }
    return { status: "pending" }
  }
  const res = await fetch(`${API_BASE}/license/auth/poll/${encodeURIComponent(pin)}`)
  if (!res.ok) throw new Error(`auth/poll ${res.status}`)
  return res.json()
}

function friendlyError(code: string): string {
  const map: Record<string, string> = {
    invalid_username: "Username: 3-32 caratteri (lettere, numeri, _, -, .).",
    invalid_password: "Password: minimo 8 caratteri.",
    username_taken: "Username già in uso. Prova ad accedere.",
    invalid_credentials: "Username o password errati.",
    account_revoked: "Account disabilitato. Contatta @OpCrime1312.",
    account_rejected: "Richiesta respinta. Contatta @OpCrime1312.",
    account_pending_approval: "Account in attesa di approvazione.",
    missing_credentials: "Inserisci username e password.",
    rate_limited: "Troppi tentativi. Riprova tra un minuto.",
  }
  return map[code] ?? code
}

export function WorkspaceSwitcher() {
  const client = getTeamsClient()
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal<ActiveWorkspace>(readActive())
  const [account] = createResource(async () => {
    const api = (window as unknown as { api?: { account?: { get: () => Promise<unknown> } } }).api
    if (api?.account?.get) return api.account.get()
    return readWebSession()
  })
  // The teams list MUST react to `account` resolving — using the two-arg
  // form of createResource makes Solid track the source signal and re-run
  // the fetcher whenever account changes (e.g. once the persisted session
  // loads from electron-store / localStorage on app boot). With the
  // previous single-arg form, teams resolved to [] before account was
  // ready and never refetched, so on every restart the user saw an empty
  // teams panel even though their session was perfectly intact.
  const [teams, { refetch: refetchTeams }] = createResource(
    () => account() ?? null,
    async (acc) => {
      if (!acc) return []
      const r = await client.list()
      return r.teams
    },
  )
  const [showCreate, setShowCreate] = createSignal(false)
  const [manageId, setManageId] = createSignal<string | null>(null)

  // Login form state
  const [showLogin, setShowLogin] = createSignal(false)
  const [loginMode, setLoginMode] = createSignal<"signin" | "signup">("signin")
  const [user, setUser] = createSignal("")
  const [pass, setPass] = createSignal("")
  const [tgHandle, setTgHandle] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)

  // Telegram auth state
  const [tgPin, setTgPin] = createSignal<string | null>(null)
  const [tgBotUrl, setTgBotUrl] = createSignal("")
  const [tgPolling, setTgPolling] = createSignal(false)

  // Pending approval state
  const [pendingCid, setPendingCid] = createSignal<string | null>(null)

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
    // Tear down any team-live-session we were in (heartbeat loop +
    // localStorage key) — leaving the session id behind would have
    // live-cursors keep publishing into the wrong team's SSE channel.
    void leaveActiveTeamSession()
    close()
  }

  function onPickTeam(team: TeamSummary) {
    const w: ActiveWorkspace = { kind: "team", id: team.id }
    setActive(w)
    writeActive(w)
    // Eagerly join (or start) the team's live session so cursor sync,
    // presence and the SSE event stream all activate without the user
    // having to click anything else. Best-effort: any failure leaves
    // the workspace selection in place but cursor sync stays off.
    void joinOrStartTeamSession(team.id)
    close()
  }

  function openLogin() {
    setShowLogin(true)
    setLoginMode("signin")
    setUser("")
    setPass("")
    setTgHandle("")
    setError(null)
    setTgPin(null)
    setPendingCid(null)
  }

  function closeLogin() {
    setShowLogin(false)
    setTgPin(null)
    setTgPolling(false)
    if (tgTimer) {
      clearInterval(tgTimer)
      tgTimer = null
    }
    if (approvalTimer) {
      clearInterval(approvalTimer)
      approvalTimer = null
    }
  }

  async function submitAccount(e: Event) {
    e.preventDefault()
    setError(null)
    const trimmed = user().trim()
    if (trimmed.length < 3 || trimmed.length > 32 || !/^[a-zA-Z0-9_.\-]+$/.test(trimmed)) {
      setError(friendlyError("invalid_username"))
      return
    }
    if (pass().length < 8) {
      setError(friendlyError("invalid_password"))
      return
    }
    setSubmitting(true)
    try {
      const fn = loginMode() === "signup" ? signUpWithAccount : signInWithAccount
      const result = await fn({
        username: trimmed,
        password: pass(),
        ...(loginMode() === "signup" && tgHandle().trim() ? { telegram: tgHandle().trim() } : {}),
        device_label: `web (${navigator.userAgent.slice(0, 60)})`,
      })
      if (result.status === "approved") {
        writeWebSession({
          token: result.token,
          customer_id: result.customer_id,
          telegram_user_id: null,
          expires_at: result.exp,
        })
        closeLogin()
        window.location.reload()
      } else if (result.status === "pending") {
        setPendingCid(result.customer_id)
        startApprovalPolling(result.customer_id)
      }
    } catch (err: any) {
      setError(friendlyError(err?.message || "Errore di autenticazione"))
    } finally {
      setSubmitting(false)
    }
  }

  // Telegram auth
  let tgTimer: ReturnType<typeof setInterval> | null = null
  async function startTelegram() {
    setError(null)
    setTgPin(null)
    try {
      const s = await startTgAuth()
      setTgPin(s.pin)
      setTgBotUrl(s.bot_url)
      setTgPolling(true)
      window.open(s.bot_url, "_blank", "noopener")
      tgTimer = setInterval(async () => {
        try {
          const r = await pollTgAuth(s.pin)
          if (r.status === "ok") {
            clearInterval(tgTimer!)
            tgTimer = null
            setTgPolling(false)
            setTgPin(null)
            writeWebSession({
              token: r.token as string,
              customer_id: r.customer_id as string,
              telegram_user_id: null,
              expires_at: r.exp as number,
            })
            closeLogin()
            window.location.reload()
          }
          if (r.status === "awaiting_approval") {
            clearInterval(tgTimer!)
            tgTimer = null
            setTgPolling(false)
            setTgPin(null)
            setPendingCid(r.customer_id as string)
            startApprovalPolling(r.customer_id as string)
          }
          if (r.status === "rejected") {
            clearInterval(tgTimer!)
            tgTimer = null
            setTgPolling(false)
            setTgPin(null)
            setPendingCid(r.customer_id as string)
            setError("Richiesta respinta dall'admin.")
          }
          if (r.status === "expired") {
            clearInterval(tgTimer!)
            tgTimer = null
            setTgPolling(false)
            setTgPin(null)
            setError("PIN scaduto. Riprova.")
          }
        } catch (err) {
          clearInterval(tgTimer!)
          tgTimer = null
          setTgPolling(false)
          setTgPin(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Approval polling
  let approvalTimer: ReturnType<typeof setInterval> | null = null
  function startApprovalPolling(cid: string) {
    setTgPin(null)
    setTgPolling(false)
    approvalTimer = setInterval(async () => {
      try {
        const st = await fetchApprovalStatus(cid)
        if (st.status === "approved") {
          clearInterval(approvalTimer!)
          approvalTimer = null
          // Re-sign in now that approved
          try {
            const result = await signInWithAccount({ username: user() || "bearer", password: pass() })
            if (result.status === "approved") {
              writeWebSession({
                token: result.token,
                customer_id: result.customer_id,
                telegram_user_id: null,
                expires_at: result.exp,
              })
              closeLogin()
              window.location.reload()
            }
          } catch {
            setError("Approvato! Ora accedi con le tue credenziali.")
            setPendingCid(null)
          }
        } else if (st.status === "rejected") {
          clearInterval(approvalTimer!)
          approvalTimer = null
          setError("Richiesta respinta dall'admin.")
          setPendingCid(null)
        }
      } catch {
        // keep polling
      }
    }, 5000)
  }

  onCleanup(() => {
    if (tgTimer) {
      clearInterval(tgTimer)
      tgTimer = null
    }
    if (approvalTimer) {
      clearInterval(approvalTimer)
      approvalTimer = null
    }
  })

  async function handleSignOut() {
    close()
    await logoutSession()
    window.location.reload()
  }

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
                      when={showLogin()}
                      fallback={
                        <div data-slot="not-signed-in">
                          <div data-slot="not-signed-in-title">Accedi per creare o unirti a un Team</div>
                          <div data-slot="not-signed-in-sub">
                            I Team Workspace ti permettono di condividere progetti e collaborare in tempo reale.
                          </div>
                          <button type="button" data-slot="tg-login" onClick={startTelegram}>
                            <span data-slot="signin-icon" aria-hidden="true">
                              📱
                            </span>
                            <span data-slot="signin-label">Accedi con Telegram</span>
                          </button>
                          <div data-slot="divider">
                            <span>oppure</span>
                          </div>
                          <button type="button" data-slot="signin" onClick={openLogin}>
                            <span data-slot="signin-icon" aria-hidden="true">
                              🔑
                            </span>
                            <span data-slot="signin-label">Username e password</span>
                          </button>
                        </div>
                      }
                    >
                      {/* Pending approval */}
                      <Show
                        when={pendingCid()}
                        fallback={
                          <>
                            {/* Telegram login in progress */}
                            <Show
                              when={tgPin()}
                              fallback={
                                <div data-slot="login-panel">
                                  <div data-slot="login-tabs">
                                    <button
                                      type="button"
                                      data-slot="tab"
                                      data-active={loginMode() === "signin"}
                                      onClick={() => setLoginMode("signin")}
                                    >
                                      Accedi
                                    </button>
                                    <button
                                      type="button"
                                      data-slot="tab"
                                      data-active={loginMode() === "signup"}
                                      onClick={() => setLoginMode("signup")}
                                    >
                                      Crea account
                                    </button>
                                  </div>
                                  <form data-slot="login-form" onSubmit={submitAccount}>
                                    <input
                                      type="text"
                                      placeholder="Username"
                                      value={user()}
                                      onInput={(e) => setUser(e.currentTarget.value)}
                                      minlength={3}
                                      maxlength={32}
                                      required
                                    />
                                    <input
                                      type="password"
                                      placeholder="Password"
                                      value={pass()}
                                      onInput={(e) => setPass(e.currentTarget.value)}
                                      minlength={8}
                                      required
                                    />
                                    <Show when={loginMode() === "signup"}>
                                      <input
                                        type="text"
                                        placeholder="Telegram @username (opzionale)"
                                        value={tgHandle()}
                                        onInput={(e) => setTgHandle(e.currentTarget.value)}
                                      />
                                    </Show>
                                    <Show when={error()}>
                                      <div data-slot="login-error">{error()}</div>
                                    </Show>
                                    <div data-slot="login-actions">
                                      <button type="button" onClick={closeLogin}>
                                        Annulla
                                      </button>
                                      <button type="submit" disabled={submitting()}>
                                        {submitting() ? "Caricamento..." : loginMode() === "signup" ? "Crea" : "Accedi"}
                                      </button>
                                    </div>
                                  </form>
                                  <button type="button" data-slot="tg-login-bottom" onClick={startTelegram}>
                                    📱 Accedi con Telegram
                                  </button>
                                </div>
                              }
                            >
                              <div data-slot="tg-polling">
                                <div data-slot="tg-polling-icon">📱</div>
                                <div data-slot="tg-polling-title">Apri Telegram</div>
                                <div data-slot="tg-polling-sub">Clicca il link nel bot Telegram per accedere</div>
                                <button type="button" onClick={() => window.open(tgBotUrl(), "_blank", "noopener")}>
                                  Apri Telegram
                                </button>
                                <div data-slot="tg-polling-spinner">
                                  <span class="loading-dot" />
                                  <span class="loading-dot" />
                                  <span class="loading-dot" />
                                </div>
                              </div>
                            </Show>
                          </>
                        }
                      >
                        <div data-slot="approval-pending">
                          <div data-slot="approval-icon">⏳</div>
                          <div data-slot="approval-title">In attesa di approvazione</div>
                          <div data-slot="approval-sub">
                            Il tuo account è stato creato. Un admin deve approvarlo prima di accedere.
                          </div>
                          <div data-slot="approval-spinner">
                            <span class="loading-dot" />
                            <span class="loading-dot" />
                            <span class="loading-dot" />
                          </div>
                          <button type="button" onClick={closeLogin}>
                            Chiudi
                          </button>
                        </div>
                      </Show>
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
