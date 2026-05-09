import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import {
  avatarUrl,
  blockUser,
  getInbox,
  openConversationWith,
  openDmStream,
  sendDm,
  type DmConversation,
  type DmConversationDetail,
  type DmMessage,
} from "@/utils/community-client"

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "ora"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`
  if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}g`
  return new Date(ts).toLocaleDateString()
}

interface DmPanelProps {
  myUsername: string | null
  initialPeer?: string
}

export const DmPanel: Component<DmPanelProps> = (props) => {
  const [activePeer, setActivePeer] = createSignal<string | null>(props.initialPeer ?? null)
  const [draft, setDraft] = createSignal("")
  const [posting, setPosting] = createSignal(false)
  const [composeUsername, setComposeUsername] = createSignal("")
  const [showCompose, setShowCompose] = createSignal(false)
  let scrollEl: HTMLDivElement | undefined

  const [inbox, { refetch: refetchInbox }] = createResource(async () => await getInbox())

  const [conversation, { refetch: refetchConv }] = createResource(activePeer, async (peer) => {
    if (!peer) return null
    return await openConversationWith(peer)
  })

  const scrollBottom = (smooth = false) => {
    requestAnimationFrame(() => {
      const el = scrollEl
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    })
  }

  // Carica + scroll bottom quando cambia conversazione
  createEffect(() => {
    if (conversation()) {
      scrollBottom(false)
    }
  })

  // SSE personale: aggiorna conversazione live + inbox unread badge
  createEffect(() => {
    if (!props.myUsername) return
    const es = openDmStream()
    if (!es) return

    es.addEventListener("message", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          type: string
          conversation_id: number
          message: { id: number; sender_username: string; body: string; ts: number }
        }
        // Refetch inbox per aggiornare last_message + unread count
        void refetchInbox()
        // Se è la conversazione attiva, prependi il messaggio direttamente
        const cur = conversation()
        const peerUsername = activePeer()
        if (cur && peerUsername && data.conversation_id === cur.conversation_id) {
          // Re-fetch è semplice e robusto; appende e marca read
          void refetchConv()
          scrollBottom(true)
        } else if (data.message.sender_username !== props.myUsername) {
          // Notifica visiva veloce
          showToast({
            variant: "success",
            title: `Nuovo DM da @${data.message.sender_username}`,
            description: data.message.body.slice(0, 80),
          })
        }
      } catch {
        /* ignore */
      }
    })
    es.addEventListener("read", () => void refetchConv())

    onCleanup(() => es.close())
  })

  const send = async () => {
    const peer = activePeer()
    const body = draft().trim()
    if (!peer || !body) return
    setPosting(true)
    try {
      const res = await sendDm(peer, body)
      if (!res.ok) {
        showToast({ variant: "error", title: "Invio DM fallito", description: res.error })
        return
      }
      setDraft("")
      // Re-fetch conv (simpler than optimistic insert + dedup)
      void refetchConv()
      void refetchInbox()
      scrollBottom(true)
    } finally {
      setPosting(false)
    }
  }

  const startConversation = () => {
    const peer = composeUsername().trim()
    if (!peer) return
    setActivePeer(peer)
    setComposeUsername("")
    setShowCompose(false)
  }

  const handleBlock = async () => {
    const peer = activePeer()
    if (!peer) return
    if (!confirm(`Bloccare @${peer}? Non potrà più mandarti DM.`)) return
    const ok = await blockUser(peer)
    if (ok) {
      showToast({ variant: "success", title: `@${peer} bloccato` })
      setActivePeer(null)
      void refetchInbox()
    } else {
      showToast({ variant: "error", title: "Block fallito" })
    }
  }

  const composer = createMemo(() => activePeer() !== null)

  return (
    <div class="flex h-[calc(100vh-12rem)] min-h-100 bg-surface-base border border-surface-weak rounded-lg overflow-hidden">
      {/* Inbox sidebar */}
      <div class="w-72 shrink-0 border-r border-surface-weak flex flex-col">
        <div class="px-3 py-2 border-b border-surface-weak flex items-center justify-between">
          <span class="text-12-semibold">Conversazioni</span>
          <button
            onClick={() => setShowCompose((v) => !v)}
            class="text-11-regular text-text-weak hover:text-text-strong"
            title="Nuovo DM"
          >
            + nuovo
          </button>
        </div>

        <Show when={showCompose()}>
          <div class="px-3 py-2 border-b border-surface-weak bg-surface-weak/30">
            <input
              type="text"
              value={composeUsername()}
              onInput={(e) => setComposeUsername(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  startConversation()
                }
              }}
              placeholder="@username"
              class="w-full bg-surface-base border border-surface-weak rounded px-2 py-1 text-12-regular focus:outline-none focus:border-icon-warning-base"
            />
            <div class="flex gap-1 mt-1">
              <Button size="small" variant="primary" onClick={startConversation}>
                Apri
              </Button>
              <Button size="small" variant="ghost" onClick={() => setShowCompose(false)}>
                Annulla
              </Button>
            </div>
          </div>
        </Show>

        <div class="flex-1 overflow-y-auto">
          <Show
            when={(inbox() ?? []).length > 0}
            fallback={
              <div class="px-3 py-6 text-11-regular text-text-weak text-center">
                Nessuna conversazione.<br />
                Click "+ nuovo" per iniziare.
              </div>
            }
          >
            <For each={inbox() ?? []}>
              {(conv: DmConversation) => (
                <button
                  onClick={() => setActivePeer(conv.peer_username)}
                  class="w-full flex items-center gap-2 px-3 py-2 border-b border-surface-weak hover:bg-surface-raised-base-hover text-left transition-colors"
                  classList={{
                    "bg-surface-weak/50": activePeer() === conv.peer_username,
                  }}
                >
                  <img
                    src={avatarUrl(conv.peer_avatar_seed, 28)}
                    alt={conv.peer_username}
                    class="size-7 rounded-full bg-surface-weak shrink-0"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1">
                      <span class="text-12-semibold truncate">@{conv.peer_username}</span>
                      <span class="ml-auto shrink-0 text-10-regular text-text-weak">
                        {formatRelative(conv.last_message_at)}
                      </span>
                    </div>
                    <Show when={conv.last_body}>
                      <div class="text-11-regular text-text-weak truncate">{conv.last_body}</div>
                    </Show>
                  </div>
                  <Show when={conv.unread_count > 0}>
                    <span class="ml-1 shrink-0 text-10-regular px-1.5 py-0.5 rounded bg-icon-warning-base text-text-contrast">
                      {conv.unread_count}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Conversation pane */}
      <div class="flex-1 flex flex-col min-w-0">
        <Show
          when={composer() && conversation()}
          fallback={
            <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak text-center px-4">
              <Show
                when={activePeer()}
                fallback={<span>Seleziona una conversazione a sinistra<br />o avvia un nuovo DM.</span>}
              >
                <span>Caricamento conversazione…</span>
              </Show>
            </div>
          }
        >
          {(c) => (
            <>
              <div class="px-3 py-2 border-b border-surface-weak flex items-center gap-2">
                <span class="text-12-semibold">@{c().peer.username}</span>
                <button
                  onClick={handleBlock}
                  class="ml-auto text-11-regular text-text-weak hover:text-text-on-critical-base"
                >
                  Blocca
                </button>
              </div>
              <div ref={(el) => (scrollEl = el)} class="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                <Show
                  when={c().messages.length > 0}
                  fallback={
                    <div class="h-full flex items-center justify-center text-12-regular text-text-weak text-center">
                      Nessun messaggio ancora. Scrivi qualcosa qui sotto 👇
                    </div>
                  }
                >
                  <For each={c().messages}>
                    {(msg: DmMessage) => (
                      <div
                        class="flex"
                        classList={{
                          "justify-end": msg.is_mine,
                          "justify-start": !msg.is_mine,
                        }}
                      >
                        <div
                          class="max-w-[80%] rounded px-2.5 py-1.5"
                          classList={{
                            "bg-icon-warning-base/20 text-text-strong": msg.is_mine,
                            "bg-surface-weak text-text-strong": !msg.is_mine,
                          }}
                        >
                          <div class="text-12-regular whitespace-pre-wrap break-words">{msg.body}</div>
                          <div class="text-10-regular text-text-weak mt-0.5 flex items-center gap-1">
                            <span>{formatRelative(msg.ts)}</span>
                            <Show when={msg.is_mine && msg.read_at}>
                              <span title="Letto">✓✓</span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>

              <Show when={props.myUsername}>
                <div class="border-t border-surface-weak p-2 flex gap-2 items-end">
                  <textarea
                    value={draft()}
                    onInput={(e) => setDraft(e.currentTarget.value.slice(0, 2000))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        void send()
                      }
                    }}
                    placeholder={`Scrivi a @${c().peer.username}...`}
                    rows={2}
                    class="flex-1 bg-surface-base border border-surface-weak rounded px-2 py-1.5 text-12-regular text-text-strong resize-none focus:outline-none focus:border-icon-warning-base"
                    disabled={posting()}
                  />
                  <Button variant="primary" size="small" onClick={() => void send()} disabled={posting() || !draft().trim()}>
                    Invia
                  </Button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
