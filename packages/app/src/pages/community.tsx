import { Component, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import {
  avatarUrl,
  getLeaderboard,
  getMyProfile,
  getPublicProfile,
  hasAccountSession,
  setUsername,
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

const CommunityPage: Component = () => {
  const navigate = useNavigate()
  const [period, setPeriod] = createSignal<"30d" | "all">("30d")
  const [signedIn, setSignedIn] = createSignal(hasAccountSession())
  const [usernameDraft, setUsernameDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [selectedUser, setSelectedUser] = createSignal<string | null>(null)

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
            Leaderboard utenti CrimeCode IDE · profili pubblici · presto chat live + DM
          </p>
        </div>
      </div>

      {/* Body */}
      <div class="flex-1 overflow-y-auto p-4">
        <div class="max-w-4xl mx-auto space-y-4">
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

          {/* Coming soon footer */}
          <div class="bg-surface-base/50 border border-surface-weak rounded-lg p-4 text-12-regular text-text-weak">
            <div class="font-semibold text-text-strong mb-1 flex items-center gap-2">
              <Icon name="code-lines" size="small" /> Coming soon
            </div>
            <ul class="ml-4 list-disc space-y-0.5">
              <li>Phase 2: Chat globale live tra tutti gli utenti connessi</li>
              <li>Phase 3: DM 1:1, sistema +rep tra utenti, badges & achievements</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CommunityPage
