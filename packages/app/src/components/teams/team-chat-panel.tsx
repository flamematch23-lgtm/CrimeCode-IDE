/**
 * TeamChatPanel — real-time chat between team members.
 *
 *   - Messages stream in via the SSE event bus (`chat_message` events
 *     bridged through the Electron preload IPC subscribe API, see
 *     packages/desktop-electron/src/preload/index.ts and main/ipc.ts).
 *   - Hydrates on mount with the most-recent 50 messages from the
 *     /license/teams/:id/chat endpoint (server keeps last 200 per team).
 *   - Composer auto-grows; Enter sends, Shift+Enter inserts a newline.
 *   - Typing indicator: posted at most every 1.5 s while the local user
 *     is typing; remote indicators fade after 3 s of silence.
 *   - Author labels follow Telegram convention when available
 *     (`@username`), otherwise fall back to the chosen username from the
 *     classic signup, otherwise the truncated customer id.
 *   - Avatar colour is a deterministic hash of customer id so the same
 *     person looks the same here and in the live-cursors / presence
 *     overlay.
 */
import {
  Show,
  For,
  createMemo,
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  createResource,
} from "solid-js"
import {
  getTeamsClient,
  type TeamChatMessage,
  type TeamEvent,
  type TeamMember,
} from "../../utils/teams-client"

interface Props {
  teamId: string
  selfCustomerId?: string | null
  /** Optional roster from the parent so we can render @handle / role even
   *  when a chat author is no longer in the live members list. */
  members?: TeamMember[]
}

interface TypingState {
  customer_id: string
  author_name: string | null
  at: number
}

const TYPING_THROTTLE_MS = 1500
const TYPING_FADE_MS = 3000

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

function formatLabel(authorName: string | null, customerId: string): string {
  if (!authorName) return customerId.slice(0, 10)
  // Already a Telegram-style handle?
  if (authorName.startsWith("@")) return authorName
  // Looks like an email? Strip the domain so it stays compact.
  if (authorName.includes("@")) return authorName.split("@")[0]
  // Plain username from the classic signup form.
  return authorName
}

function formatTime(ts: number): string {
  // ts is in seconds (server) — defensively detect ms vs s
  const ms = ts > 10_000_000_000 ? ts : ts * 1000
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function isSameDay(a: number, b: number): boolean {
  const aMs = a > 10_000_000_000 ? a : a * 1000
  const bMs = b > 10_000_000_000 ? b : b * 1000
  const da = new Date(aMs)
  const db = new Date(bMs)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

function formatDayDivider(ts: number): string {
  const ms = ts > 10_000_000_000 ? ts : ts * 1000
  const d = new Date(ms)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (isSameDay(d.getTime() / 1000, today.getTime() / 1000)) return "Oggi"
  if (isSameDay(d.getTime() / 1000, yesterday.getTime() / 1000)) return "Ieri"
  return d.toLocaleDateString()
}

export function TeamChatPanel(props: Props) {
  const client = getTeamsClient()
  const [messages, setMessages] = createSignal<TeamChatMessage[]>([])
  const [typingMap, setTypingMap] = createSignal<Record<string, TypingState>>({})
  const [draft, setDraft] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let lastTypingAt = 0
  let scrollEl: HTMLDivElement | undefined
  let textareaEl: HTMLTextAreaElement | undefined
  let stickToBottom = true

  // Hydrate
  const [hydrated] = createResource(
    () => props.teamId,
    async (id) => {
      try {
        const r = await client.listChat(id, 50)
        setMessages(r.messages ?? [])
        return true
      } catch {
        return false
      }
    },
  )

  // Subscribe SSE
  createEffect(() => {
    const id = props.teamId
    if (!id) return
    const unsub = client.subscribe(id, (ev: TeamEvent) => {
      if (ev.type === "chat_message") {
        const msg: TeamChatMessage = {
          id: ev.message_id ?? Date.now(),
          team_id: ev.team_id ?? id,
          customer_id: ev.customer_id ?? "",
          author_name: ev.author_name ?? null,
          text: ev.text ?? "",
          ts: ev.ts ?? Math.floor(Date.now() / 1000),
        }
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, msg]
        })
      } else if (ev.type === "chat_typing" && ev.customer_id) {
        // Don't render the indicator for ourselves
        if (props.selfCustomerId && ev.customer_id === props.selfCustomerId) return
        const cid = ev.customer_id
        setTypingMap((prev) => ({
          ...prev,
          [cid]: { customer_id: cid, author_name: ev.author_name ?? null, at: Date.now() },
        }))
      }
    })
    onCleanup(unsub)
  })

  // GC stale typing entries every second
  onMount(() => {
    const t = setInterval(() => {
      setTypingMap((prev) => {
        const cutoff = Date.now() - TYPING_FADE_MS
        let dirty = false
        const next: Record<string, TypingState> = {}
        for (const [k, v] of Object.entries(prev)) {
          if (v.at >= cutoff) next[k] = v
          else dirty = true
        }
        return dirty ? next : prev
      })
    }, 1000)
    onCleanup(() => clearInterval(t))
  })

  // Auto-scroll to bottom on new message (unless user scrolled up)
  createEffect(() => {
    messages() // dep
    if (!scrollEl) return
    if (stickToBottom) {
      // queue to next frame so the DOM is laid out
      requestAnimationFrame(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
      })
    }
  })

  function onScroll() {
    if (!scrollEl) return
    const distFromBottom = scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop
    stickToBottom = distFromBottom < 24
  }

  function autoGrow() {
    if (!textareaEl) return
    textareaEl.style.height = "auto"
    textareaEl.style.height = Math.min(160, textareaEl.scrollHeight) + "px"
  }

  function onInput(value: string) {
    setDraft(value)
    autoGrow()
    const now = Date.now()
    if (now - lastTypingAt > TYPING_THROTTLE_MS && value.trim()) {
      lastTypingAt = now
      void client.postTyping(props.teamId).catch(() => undefined)
    }
  }

  async function send() {
    const text = draft().trim()
    if (!text) return
    if (sending()) return
    setSending(true)
    setError(null)
    try {
      const r = await client.postChat(props.teamId, text)
      // Optimistic insert (the SSE event will dedupe by id)
      if (r?.message) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === r.message.id)) return prev
          return [...prev, r.message]
        })
      }
      setDraft("")
      stickToBottom = true
      // textarea height reset
      if (textareaEl) {
        textareaEl.style.height = "auto"
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  // Group messages with their previous neighbour by author + small time gap
  const grouped = createMemo(() => {
    const out: Array<{
      msg: TeamChatMessage
      showHeader: boolean
      showDayDivider: boolean
    }> = []
    const list = messages()
    for (let i = 0; i < list.length; i++) {
      const cur = list[i]
      const prev = list[i - 1]
      const showDayDivider = !prev || !isSameDay(prev.ts, cur.ts)
      const sameAuthor = prev && prev.customer_id === cur.customer_id
      const closeInTime = prev ? Math.abs((cur.ts - prev.ts)) < 60 * 5 : false
      const showHeader = showDayDivider || !sameAuthor || !closeInTime
      out.push({ msg: cur, showHeader, showDayDivider })
    }
    return out
  })

  const typingList = createMemo(() => Object.values(typingMap()))

  const memberDisplayLookup = createMemo(() => {
    const m = new Map<string, string>()
    for (const member of props.members ?? []) {
      const label = member.telegram ?? member.display ?? null
      if (label) m.set(member.customer_id, label)
    }
    return m
  })

  function authorLabel(msg: TeamChatMessage): string {
    const fromRoster = memberDisplayLookup().get(msg.customer_id)
    return formatLabel(fromRoster ?? msg.author_name, msg.customer_id)
  }

  return (
    <div data-component="team-chat-panel">
      <div data-slot="header">
        <span data-slot="title">Chat del team</span>
        <span data-slot="subtitle">
          <Show when={hydrated.loading} fallback={<>{messages().length} messaggi</>}>
            Caricamento…
          </Show>
        </span>
      </div>

      <div data-slot="scroll" ref={(el) => (scrollEl = el)} onScroll={onScroll}>
        <Show
          when={messages().length > 0}
          fallback={
            <div data-slot="empty">
              <div data-slot="empty-icon">💬</div>
              <div data-slot="empty-title">Nessun messaggio</div>
              <div data-slot="empty-sub">Inizia tu la conversazione con il tuo team.</div>
            </div>
          }
        >
          <For each={grouped()}>
            {(g) => {
              const isSelf = g.msg.customer_id === props.selfCustomerId
              const color = colorFor(g.msg.customer_id)
              const label = authorLabel(g.msg)
              return (
                <>
                  <Show when={g.showDayDivider}>
                    <div data-slot="day-divider">
                      <span>{formatDayDivider(g.msg.ts)}</span>
                    </div>
                  </Show>
                  <div data-slot="message" data-self={isSelf ? "true" : "false"} data-grouped={!g.showHeader ? "true" : "false"}>
                    <Show
                      when={g.showHeader}
                      fallback={
                        <div data-slot="message-spacer">
                          <span data-slot="hover-time">{formatTime(g.msg.ts)}</span>
                        </div>
                      }
                    >
                      <div data-slot="avatar" style={{ "--avatar-color": color } as never}>
                        {initialsOf(label)}
                      </div>
                    </Show>
                    <div data-slot="bubble-wrap">
                      <Show when={g.showHeader}>
                        <div data-slot="message-header">
                          <span data-slot="author">{label}</span>
                          <span data-slot="time">{formatTime(g.msg.ts)}</span>
                        </div>
                      </Show>
                      <div data-slot="bubble">{g.msg.text}</div>
                    </div>
                  </div>
                </>
              )
            }}
          </For>
        </Show>
      </div>

      <Show when={typingList().length > 0}>
        <div data-slot="typing-row">
          <span data-slot="typing-dots">
            <span /> <span /> <span />
          </span>
          <span data-slot="typing-text">
            {typingList().length === 1
              ? `${formatLabel(typingList()[0].author_name, typingList()[0].customer_id)} sta scrivendo…`
              : `${typingList().length} membri stanno scrivendo…`}
          </span>
        </div>
      </Show>

      <Show when={error()}>
        <div data-slot="error">{error()}</div>
      </Show>

      <div data-slot="composer">
        <textarea
          ref={(el) => (textareaEl = el)}
          data-slot="textarea"
          placeholder="Scrivi un messaggio…"
          rows="1"
          value={draft()}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          data-slot="send"
          onClick={send}
          disabled={sending() || !draft().trim()}
          aria-label="Invia messaggio"
        >
          <Show when={sending()} fallback={<span data-slot="send-icon">▶</span>}>
            <span data-slot="send-spinner" />
          </Show>
        </button>
      </div>
      <div data-slot="footer-hint">
        Enter per inviare · Shift+Enter per andare a capo · I messaggi sono visibili a tutti i membri del team.
      </div>
    </div>
  )
}
