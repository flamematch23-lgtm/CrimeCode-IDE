import { Component, createMemo, createResource, createSignal, createEffect, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import {
  avatarUrl,
  deleteMessage,
  getChatStats,
  getLeaderboard,
  getMyProfile,
  getPublicProfile,
  getRecentMessages,
  hasAccountSession,
  openChatStream,
  postMessage,
  setUsername,
  type ChatMessage,
  type LeaderboardEntry,
} from "@/utils/community-client"

const PERIOD_LABELS: Record<"30d" | "all", string> = {
  "30d": "Ultimi 30 giorni",
  all: "Sempre",
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "ora"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m fa`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h fa`
  if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}g fa`
  return `${Math.floor(diff / (30 * 86400_000))}mese fa`
}

function rankBadge(rank: number): { color: string; label: string } {
  if (rank === 1) return { color: "text-icon-warning-base", label: "🥇" }
  if (rank === 2) return { color: "text-text-secondary", label: "🥈" }
  if (rank === 3) return { color: "text-icon-warning-base", label: "🥉" }
  return { color: "text-text-weak", label: `#${rank}` }
}

// ─── Phase 2: Chat panel ─────────────────────────────────────────────

function ChatPanel(props: { myUsername: string | null; mySeed: string | null }) {
  const navigate = useNavigate()
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [draft, setDraft] = createSignal("")
  const [posting, setPosting] = createSignal(false)
  const [live, setLive] = createSignal(false)
  let scrollEl: HTMLDivElement | undefined
  let textareaEl: HTMLTextAreaElement | undefined

  const isAtBottom = () => {
    const el = scrollEl
    if (!el) return true
    return el.scrollHeight - el.clientHeight - el.scrollTop < 60
  }

  const scrollToBottom = (smooth = true) => {
    requestAnimationFrame(() => {
      const el = scrollEl
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    })
  }

  // Initial load + SSE subscribe
  createEffect(() => {
    let alive = true

    void getRecentMessages(100)
      .then((msgs) => {
        if (!alive) return
        setMessages(msgs)
        scrollToBottom(false)
      })
      .catch(() => undefined)

    const es = openChatStream()
    es.addEventListener("open", () => alive && setLive(true))
    es.addEventListener("error", () => alive && setLive(false))
    es.addEventListener("message", (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data) as ChatMessage
        // Cancellazione: la backend manda un msg con username "_deleted_"
        if (msg.username === "_deleted_") {
          setMessages((prev) =>
            prev.map((m) => (m.id === msg.id ? { ...m, body: "[messaggio cancellato]", username: "_deleted_" } : m)),
          )
          return
        }
        const stick = isAtBottom()
        setMessages((prev) => {
          // Dedup contro l'echo del POST locale che potrebbe arrivare anche via SSE
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, msg]
        })
        if (stick) scrollToBottom(true)
      } catch {
        /* ignora payload malformati */
      }
    })

    onCleanup(() => {
      alive = false
      es.close()
    })
  })

  const send = async () => {
    if (!props.myUsername) {
      showToast({
        variant: "error",
        title: "Username mancante",
        description: "Imposta prima un username pubblico nella tab Leaderboard.",
      })
      return
    }
    const text = draft().trim()
    if (!text) return
    setPosting(true)
    try {
      const res = await postMessage(text)
      if (!res.ok) {
        showToast({ variant: "error", title: "Invio fallito", description: res.error })
        return
      }
      // Optimistic insert (anche se l'SSE re-deliveri, dedupiamo)
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]))
      setDraft("")
      scrollToBottom(true)
    } finally {
      setPosting(false)
      textareaEl?.focus()
    }
  }

  const handleDelete = async (id: number) => {
    const r = await deleteMessage(id)
    if (!r.ok) {
      showToast({ variant: "error", title: "Cancellazione fallita", description: r.error })
    }
  }

  const handleKey = (e: KeyboardEvent) => {
    // Enter = invia, Shift+Enter = newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const charCount = () => draft().length
  const charMax = 500

  return (
    <div class="flex flex-col h-[calc(100vh-12rem)] min-h-100 bg-surface-base border border-surface-weak rounded-lg overflow-hidden">
      {/* Status bar */}
      <div class="px-3 py-2 border-b border-surface-weak text-11-regular flex items-center gap-2 bg-surface-weak/30">
        <span
          class="size-2 rounded-full"
          classList={{
            "bg-icon-success-base": live(),
            "bg-icon-warning-base animate-pulse": !live(),
          }}
        />
        <span class="text-text-weak">{live() ? "Connesso live" : "Riconnessione…"}</span>
        <span class="ml-auto text-text-weak">{messages().length} msg in vista</span>
      </div>

      {/* Messages list */}
      <div ref={(el) => (scrollEl = el)} class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <Show
          when={messages().length > 0}
          fallback={
            <div class="h-full flex items-center justify-center text-12-regular text-text-weak text-center">
              Niente messaggi ancora.<br />
              Sii il primo a salutare la community 👋
            </div>
          }
        >
          <For each={messages()}>
            {(msg) => {
              const isMine = msg.username === props.myUsername
              const isDeleted = msg.username === "_deleted_"
              return (
                <div
                  class="flex gap-2 group"
                  classList={{
                    "opacity-50 italic": isDeleted,
                  }}
                >
                  <Show
                    when={!isDeleted}
                    fallback={<div class="size-7 rounded-full bg-surface-weak shrink-0" />}
                  >
                    <button
                      onClick={() => navigate(`/community?u=${encodeURIComponent(msg.username)}`)}
                      class="shrink-0"
                      title={`Profilo @${msg.username}`}
                    >
                      <img
                        src={avatarUrl(msg.username, 28)}
                        alt={msg.username}
                        class="size-7 rounded-full bg-surface-weak"
                      />
                    </button>
                  </Show>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-baseline gap-2">
                      <span
                        class="text-12-semibold"
                        classList={{
                          "text-icon-warning-base": isMine,
                        }}
                      >
                        @{msg.username}
                      </span>
                      <span class="text-10-regular text-text-weak">{formatRelative(msg.ts)}</span>
                      <Show when={isMine && !isDeleted}>
                        <button
                          onClick={() => void handleDelete(msg.id)}
                          class="ml-auto opacity-0 group-hover:opacity-60 hover:opacity-100 text-10-regular text-text-weak"
                          title="Cancella"
                        >
                          ✕
                        </button>
                      </Show>
                    </div>
                    <div class="text-12-regular text-text-base whitespace-pre-wrap break-words">{msg.body}</div>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </div>

      {/* Composer */}
      <div class="border-t border-surface-weak p-3 bg-surface-weak/20">
        <Show
          when={props.myUsername}
          fallback={
            <div class="text-11-regular text-text-weak text-center py-2">
              Imposta un username nella tab Leaderboard per scrivere in chat.
            </div>
          }
        >
          <div class="flex gap-2 items-end">
            <Show when={props.mySeed}>
              <img
                src={avatarUrl(props.mySeed!, 28)}
                alt="me"
                class="size-7 rounded-full bg-surface-weak shrink-0"
              />
            </Show>
            <textarea
              ref={(el) => (textareaEl = el)}
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value.slice(0, charMax))}
              onKeyDown={handleKey}
              placeholder={`Scrivi alla community come @${props.myUsername}…`}
              rows={2}
              class="flex-1 bg-surface-base border border-surface-weak rounded px-2 py-1.5 text-12-regular text-text-strong resize-none focus:outline-none focus:border-icon-warning-base"
              disabled={posting()}
            />
            <div class="flex flex-col gap-1 items-end shrink-0">
              <span
                class="text-10-regular"
                classList={{
                  "text-text-weak": charCount() < charMax * 0.8,
                  "text-icon-warning-base": charCount() >= charMax * 0.8 && charCount() < charMax,
                  "text-text-on-critical-base": charCount() >= charMax,
                }}
              >
                {charCount()}/{charMax}
              </span>
              <Button variant="primary" size="small" onClick={() => void send()} disabled={posting() || !draft().trim()}>
                Invia
              </Button>
            </div>
          </div>
          <div class="text-10-regular text-text-weak mt-1">Enter invia · Shift+Enter newline · 10 msg/min · slow mode 2s</div>
        </Show>
      </div>
    </div>
  )
}

const CommunityPage: Component = () => {
  const navigate = useNavigate()
  const [tab, setTab] = createSignal<"leaderboard" | "chat">("leaderboard")
  const [period, setPeriod] = createSignal<"30d" | "all">("30d")
  const [signedIn, setSignedIn] = createSignal(hasAccountSession())
  const [usernameDraft, setUsernameDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [selectedUser, setSelectedUser] = createSignal<string | null>(null)
  const [chatStats] = createResource(tab, async (t) => (t === "chat" ? await getChatStats() : null))

  // Re-check signed-in state on a 1.5s timer (cheap localStorage read).
  // Same pattern di settings-account.tsx.
  setInterval(() => {
    const next = hasAccountSession()
    if (next !== signedIn()) setSignedIn(next)
  }, 1500)

  const [me, { refetch: refetchMe }] = createResource(signedIn, async (yes) => {
    if (!yes) return null
    return await getMyProfile().catch(() => null)
  })

  const [leaderboard, { refetch: refetchLeaderboard }] = createResource(period, async (p) => {
    return await getLeaderboard(p).catch(() => null)
  })

  const [publicProfile] = createResource(selectedUser, async (u) => {
    if (!u) return null
    return await getPublicProfile(u).catch(() => null)
  })

  const handleSetUsername = async () => {
    const value = usernameDraft().trim()
    if (!value) return
    setBusy(true)
    try {
      const res = await setUsername(value)
      if (!res.ok) {
        showToast({ variant: "error", title: "Username non valido", description: res.error })
        return
      }
      showToast({ variant: "success", title: `Username impostato: @${res.username}` })
      setUsernameDraft("")
      await refetchMe()
      await refetchLeaderboard()
    } finally {
      setBusy(false)
    }
  }

  const myRank = createMemo<LeaderboardEntry | null>(() => {
    const lb = leaderboard()
    const profile = me()
    if (!lb || !profile?.username) return null
    return lb.entries.find((e) => e.username.toLowerCase() === profile.username!.toLowerCase()) ?? null
  })

  return (
    <div class="size-full flex flex-col bg-background-base text-text-strong">
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-weak bg-surface-base">
        <IconButton icon="arrow-left" variant="ghost" onClick={() => navigate("/")} aria-label="Indietro" />
        <div class="flex-1">
          <h1 class="text-14-semibold">Community</h1>
          <p class="text-11-regular text-text-weak">
            Leaderboard · profili pubblici · chat globale live · presto DM
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div class="flex gap-1 px-4 pt-3 pb-2 border-b border-surface-weak bg-surface-base">
        <For
          each={[
            { id: "leaderboard" as const, label: "Leaderboard", icon: "branch" },
            { id: "chat" as const, label: "Chat globale", icon: "code-lines" },
          ]}
        >
          {(t) => (
            <button
              onClick={() => setTab(t.id)}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-12-regular transition-colors"
              classList={{
                "bg-icon-warning-base text-text-contrast": tab() === t.id,
                "bg-surface-weak text-text-secondary hover:bg-surface-raised-base-hover": tab() !== t.id,
              }}
            >
              <Icon name={t.icon as any} class="size-4" />
              {t.label}
              <Show when={t.id === "chat" && chatStats()}>
                <span class="text-10-regular px-1.5 rounded bg-surface-base/50">
                  {chatStats()!.live_subscribers} live
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      {/* Body */}
      <div class="flex-1 overflow-y-auto p-4">
        <div class="max-w-4xl mx-auto space-y-4">

          {/* CHAT TAB */}
          <Show when={tab() === "chat"}>
            <Show
              when={signedIn()}
              fallback={
                <div class="bg-surface-warning/10 border border-surface-warning/30 rounded-lg p-4 text-12-regular">
                  <div class="font-semibold text-text-strong mb-1">Non sei loggato</div>
                  <div class="text-text-weak mb-3">Per leggere e scrivere in chat globale, accedi al tuo CrimeCode account.</div>
                  <Button variant="primary" size="small" onClick={() => navigate("/account")}>Vai a Account</Button>
                </div>
              }
            >
              <ChatPanel myUsername={me()?.username ?? null} mySeed={me()?.avatar_seed ?? null} />
            </Show>
            <Show when={chatStats()}>
              {(s) => (
                <div class="grid grid-cols-3 gap-3 text-center">
                  <div class="bg-surface-base/50 border border-surface-weak rounded p-2">
                    <div class="text-14-semibold">{s().messages_24h}</div>
                    <div class="text-10-regular text-text-weak">messaggi 24h</div>
                  </div>
                  <div class="bg-surface-base/50 border border-surface-weak rounded p-2">
                    <div class="text-14-semibold">{s().active_users_24h}</div>
                    <div class="text-10-regular text-text-weak">utenti attivi 24h</div>
                  </div>
                  <div class="bg-surface-base/50 border border-surface-weak rounded p-2">
                    <div class="text-14-semibold">{s().total_messages}</div>
                    <div class="text-10-regular text-text-weak">totale storico</div>
                  </div>
                </div>
              )}
            </Show>
          </Show>

          {/* LEADERBOARD TAB */}
          <Show when={tab() === "leaderboard"}>
          {/* Auth/me card */}
          <Switch>
            <Match when={!signedIn()}>
              <div class="bg-surface-warning/10 border border-surface-warning/30 rounded-lg p-4 text-12-regular">
                <div class="font-semibold text-text-strong mb-1">Non sei loggato</div>
                <div class="text-text-weak mb-3">
                  Per partecipare alla community (apparire in leaderboard, scegliere un username,
                  ricevere rep), accedi al tuo CrimeCode account.
                </div>
                <Button variant="primary" size="small" onClick={() => navigate("/account")}>
                  Vai a Account
                </Button>
              </div>
            </Match>
            <Match when={me() && !me()!.username}>
              <div class="bg-surface-base border border-surface-weak rounded-lg p-4">
                <div class="flex items-center gap-3 mb-3">
                  <img
                    src={avatarUrl(me()!.avatar_seed, 48)}
                    alt="avatar"
                    class="size-12 rounded-full bg-surface-weak"
                  />
                  <div>
                    <div class="text-14-semibold">Scegli il tuo username pubblico</div>
                    <div class="text-11-regular text-text-weak">
                      3-20 char alphanum, _ o -. Visibile a tutti nella community.
                    </div>
                  </div>
                </div>
                <div class="flex gap-2">
                  <div class="flex-1">
                    <TextField
                      type="text"
                      label=""
                      value={usernameDraft()}
                      onChange={setUsernameDraft}
                      placeholder="es: h4cker_42"
                    />
                  </div>
                  <Button variant="primary" size="small" onClick={handleSetUsername} disabled={busy()}>
                    {busy() ? "..." : "Imposta"}
                  </Button>
                </div>
              </div>
            </Match>
            <Match when={me()?.username}>
              <div class="bg-surface-base border border-surface-weak rounded-lg p-4 flex items-center gap-3">
                <img
                  src={avatarUrl(me()!.avatar_seed, 48)}
                  alt="avatar"
                  class="size-12 rounded-full bg-surface-weak"
                />
                <div class="flex-1 min-w-0">
                  <div class="text-14-semibold truncate">@{me()!.username}</div>
                  <div class="text-11-regular text-text-weak">
                    {me()!.events_30d} eventi (30g) · {me()!.events_total} totali · {me()!.rep_received} rep ricevuti
                  </div>
                </div>
                <Show when={myRank()}>
                  {(r) => {
                    const badge = rankBadge(r().rank)
                    return (
                      <div class={`text-16-semibold ${badge.color}`}>
                        {badge.label}
                      </div>
                    )
                  }}
                </Show>
              </div>
            </Match>
          </Switch>

          {/* Period selector */}
          <div class="flex gap-2 items-center">
            <span class="text-11-regular text-text-weak">Periodo:</span>
            <For each={["30d", "all"] as const}>
              {(p) => (
                <button
                  onClick={() => setPeriod(p)}
                  class="px-2.5 py-1 rounded text-11-regular transition-colors"
                  classList={{
                    "bg-icon-warning-base text-text-contrast": period() === p,
                    "bg-surface-weak text-text-weak hover:bg-surface-raised-base-hover": period() !== p,
                  }}
                >
                  {PERIOD_LABELS[p]}
                </button>
              )}
            </For>
            <div class="ml-auto">
              <Button variant="ghost" size="small" onClick={() => void refetchLeaderboard()}>
                ↻ Aggiorna
              </Button>
            </div>
          </div>

          {/* Leaderboard */}
          <div class="bg-surface-base rounded-lg border border-surface-weak overflow-hidden">
            <Show
              when={leaderboard()}
              fallback={
                <div class="p-8 text-center text-12-regular text-text-weak">
                  {leaderboard.loading ? "Caricamento leaderboard..." : "Leaderboard non raggiungibile."}
                </div>
              }
            >
              <Show
                when={leaderboard()!.entries.length > 0}
                fallback={
                  <div class="p-8 text-center text-12-regular text-text-weak">
                    Nessun utente in classifica per questo periodo. Sii il primo!
                  </div>
                }
              >
                <For each={leaderboard()!.entries}>
                  {(entry) => {
                    const badge = rankBadge(entry.rank)
                    return (
                      <button
                        onClick={() => setSelectedUser(entry.username)}
                        class="w-full flex items-center gap-3 px-4 py-3 border-b border-surface-weak last:border-b-0 hover:bg-surface-raised-base-hover transition-colors text-left"
                      >
                        <span class={`w-10 text-14-semibold ${badge.color}`}>{badge.label}</span>
                        <img
                          src={avatarUrl(entry.avatar_seed, 36)}
                          alt={entry.username}
                          class="size-9 rounded-full bg-surface-weak shrink-0"
                        />
                        <div class="flex-1 min-w-0">
                          <div class="text-12-semibold truncate">@{entry.username}</div>
                          <Show when={entry.bio}>
                            <div class="text-11-regular text-text-weak truncate">{entry.bio}</div>
                          </Show>
                        </div>
                        <div class="text-right shrink-0">
                          <div class="text-12-semibold">{entry.score} pt</div>
                          <div class="text-11-regular text-text-weak">
                            {entry.rep > 0 ? `${entry.rep} rep · ` : ""}
                            {formatRelative(entry.last_active)}
                          </div>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </div>

          {/* Public profile preview */}
          <Show when={publicProfile()}>
            {(p) => (
              <div class="bg-surface-base border border-surface-weak rounded-lg p-4">
                <div class="flex items-start gap-4">
                  <img
                    src={avatarUrl(p().avatar_seed, 64)}
                    alt={p().username}
                    class="size-16 rounded-full bg-surface-weak shrink-0"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <h3 class="text-16-semibold">@{p().username}</h3>
                      <button
                        onClick={() => setSelectedUser(null)}
                        class="ml-auto text-11-regular text-text-weak hover:text-text-strong"
                      >
                        ✕
                      </button>
                    </div>
                    <Show when={p().bio}>
                      <p class="text-12-regular text-text-base mb-3">{p().bio}</p>
                    </Show>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-11-regular text-text-weak">
                      <div>
                        <div class="text-text-strong text-14-semibold">{p().stats.score_30d}</div>
                        <div>Score 30g</div>
                      </div>
                      <div>
                        <div class="text-text-strong text-14-semibold">{p().stats.score_total}</div>
                        <div>Score totale</div>
                      </div>
                      <div>
                        <div class="text-text-strong text-14-semibold">{p().stats.events_total}</div>
                        <div>Eventi totali</div>
                      </div>
                      <div>
                        <div class="text-text-strong text-14-semibold">{p().rep}</div>
                        <div>Rep ricevuti</div>
                      </div>
                    </div>
                    <div class="mt-3 text-11-regular text-text-weak">
                      Membro da {new Date(p().created_at).toLocaleDateString()} · attivo {formatRelative(p().last_active)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Show>

          </Show>

          {/* Coming soon footer (visible su entrambi i tab) */}
          <div class="bg-surface-base/50 border border-surface-weak rounded-lg p-4 text-12-regular text-text-weak">
            <div class="font-semibold text-text-strong mb-1 flex items-center gap-2">
              <Icon name="code-lines" size="small" /> Phase 3 in arrivo
            </div>
            <ul class="ml-4 list-disc space-y-0.5">
              <li>DM 1:1 privati tra utenti</li>
              <li>Sistema +rep tra utenti (anti-gaming + ponderato per rank)</li>
              <li>Badges & achievements (First Bounty, Veteran, Helper, ...)</li>
              <li>Notifiche desktop su menzioni @username</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CommunityPage
