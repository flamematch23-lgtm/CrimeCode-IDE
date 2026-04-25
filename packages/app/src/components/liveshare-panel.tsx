import { createSignal, createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { useLiveShareState } from "@/context/liveshare-state"
import { showToast } from "@opencode-ai/ui/toast"
import { createLiveShareSocket, type Handle as SocketHandle } from "@/utils/live-share-socket"
import { withAuthHeaders } from "@/utils/auth-fetch"

// ── types (mirror live.ts) ───────────────────────────────────────────────────

interface Participant {
  id: string
  name: string
  joined: number
  session?: string | null
  role?: "viewer" | "editor"
  presence?: "online" | "away"
}

interface ChatMsg {
  from: string
  name: string
  text: string
  ts: number
  self?: boolean
}

interface HubStatus {
  active: boolean
  code?: string
  relay?: string | null
  port?: number
  hostname?: string
  locked?: boolean
  participants?: Participant[]
}

// ── helpers ──────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
]
function avatar(id: string, name: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length]
  const initials =
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  return { color, initials }
}

// apiGet/apiPost were top-level helpers that called `fetch` directly,
// which meant every /liveshare/* request went out without an
// Authorization header and came back 401. They're now closures built
// inside LiveSharePanel so they can pull credentials from useServer().

// ── component ────────────────────────────────────────────────────────────────

export function LiveSharePanel() {
  const server = useServer()
  const apiGet = async (base: string, path: string) => {
    const r = await fetch(`${base}${path}`, withAuthHeaders(server.current?.http))
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText || "request failed"}`)
    return r.json()
  }
  const apiPost = async (base: string, path: string, body?: unknown) => {
    const r = await fetch(
      `${base}${path}`,
      withAuthHeaders(server.current?.http, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
    )
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText || "request failed"}`)
    return r.json().catch(() => ({}))
  }
  const sync = useSync()
  const globalSync = useGlobalSync()
  const liveshare = useLiveShareState()
  const base = () => server.current?.http.url ?? ""

  const [status, setStatus] = createSignal<HubStatus>({ active: false })
  const [chat, setChat] = createStore<ChatMsg[]>([])
  const [input, setInput] = createSignal("")
  const [relayInput, setRelayInput] = createSignal("")
  const [tokenInput, setTokenInput] = createSignal("")
  const [joinCode, setJoinCode] = createSignal("")
  const [joinName, setJoinName] = createSignal("")
  const [joinToken, setJoinToken] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [sock, setSock] = createSignal<SocketHandle | null>(null)
  const wsState = () => sock()?.store.state ?? "disconnected"

  async function refresh() {
    if (!base()) return
    try {
      const d = await apiGet(base(), "/liveshare")
      setStatus(
        d.active
          ? {
              active: true,
              code: d.hub?.code,
              relay: d.hub?.relay ?? null,
              port: d.hub?.port,
              hostname: d.hub?.hostname,
              locked: d.hub?.locked ?? false,
              participants: d.hub?.participants ?? [],
            }
          : { active: false },
      )
    } catch {}
  }

  // Poll status every 5s while panel is mounted
  refresh()
  const interval = setInterval(refresh, 5000)
  onCleanup(() => {
    clearInterval(interval)
    sock()?.close()
    liveshare.deactivate()
  })

  // Broadcast presence (online/away) based on tab visibility
  createEffect(() => {
    const s = sock()
    if (!s) return
    const push = () => s.setPresence(document.visibilityState === "visible" ? "online" : "away")
    push()
    document.addEventListener("visibilitychange", push)
    onCleanup(() => document.removeEventListener("visibilitychange", push))
  })

  // Mirror socket state into the global liveshare-state store so the sidebar
  // can render an @liveshare entry while connected.
  createEffect(() => {
    const s = sock()
    if (!s) {
      liveshare.deactivate()
      return
    }
    const state = s.store.state
    if (state === "connected") {
      const self = s.store.id
      const role = s.store.participants.find((p) => p.id === self)?.role ?? null
      liveshare.activate({
        code: s.store.code ?? "",
        role,
        hostSession: s.store.hostSession,
        participants: s.store.participants.length,
      })
      return
    }
    if (state === "closed") liveshare.deactivate()
  })

  async function startShare() {
    setLoading(true)
    try {
      const relay = relayInput().trim() || undefined
      let token = tokenInput().trim()
      if (token.length < 8) {
        token = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
        setTokenInput(token)
      }
      const body: Record<string, unknown> = { token }
      if (relay) body.relay = relay
      const d = await apiPost(base(), "/liveshare/start", body)
      if (d.code) await refresh()
    } catch {}
    setLoading(false)
  }

  async function stopShare() {
    setLoading(true)
    try {
      await apiPost(base(), "/liveshare/stop")
      setStatus({ active: false })
      sock()?.close()
      setSock(null)
    } catch {}
    setLoading(false)
  }

  async function kickParticipant(id: string) {
    try {
      await apiPost(base(), `/liveshare/kick/${id}`)
      await refresh()
    } catch {}
  }

  async function toggleRole(p: Participant) {
    const next = p.role === "editor" ? "viewer" : "editor"
    try {
      await apiPost(base(), `/liveshare/role/${p.id}`, { role: next })
      await refresh()
    } catch {}
  }

  function copyCode() {
    const code = status().code
    if (!code) return
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function connectWs() {
    const s = status()
    if (!s.active || !s.code) return
    sock()?.close()

    const relay = s.relay
    const name = joinName() || "host-viewer"
    const token = joinToken().trim()
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ""
    const url = relay
      ? `${relay.replace(/^http/, "ws")}/?role=client&code=${s.code}&name=${encodeURIComponent(name)}${tokenParam}`
      : `ws://127.0.0.1:${s.port}/?code=${s.code}&name=${encodeURIComponent(name)}`

    const h = createLiveShareSocket({
      url: () => url,
      onRoleChange: (next) => {
        showToast({
          title: next === "editor" ? "You were promoted to editor" : "You are now a viewer",
          variant: next === "editor" ? "success" : "default",
        })
      },
      onMessage: (msg) => {
        if (msg.type === "event") {
          globalSync.injectLiveEvent(msg.payload as { type: string; properties?: unknown })
        } else if (msg.type === "snapshot") {
          for (const ev of (msg.events ?? []) as { type: string; properties?: unknown }[]) {
            globalSync.injectLiveEvent(ev)
          }
        }
        if (msg.type === "chat") {
          setChat(chat.length, {
            from: msg.from as string,
            name: msg.name as string,
            text: msg.text as string,
            ts: msg.ts as number,
          })
        } else if (msg.type === "joined" || msg.type === "relay_client_joined") {
          showToast({ title: `${(msg.name as string) ?? "viewer"} joined`, variant: "success" })
        } else if (msg.type === "left" || msg.type === "relay_client_left") {
          showToast({ title: `${(msg.name as string) ?? "viewer"} left` })
        } else if (msg.type === "kicked") {
          showToast({ title: "Removed from session", description: (msg.reason as string) ?? "", variant: "error" })
        } else if (msg.type === "host_paused") {
          showToast({ title: "Host paused the session" })
        } else if (msg.type === "stopped") {
          showToast({ title: "Session ended" })
        }
      },
    })
    setSock(h)
  }

  function sendChat() {
    const text = input().trim()
    if (!text) return
    sock()?.send({ type: "chat", text })
    setInput("")
  }

  return (
    <div class="flex flex-col gap-3 p-4 text-sm">
      <div class="font-semibold text-base">Live Share</div>

      <Show
        when={status().active}
        fallback={
          <div class="flex flex-col gap-2">
            <input
              class="rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
              placeholder="Relay URL (optional, e.g. ws://relay.example.com:3747)"
              value={relayInput()}
              onInput={(e) => setRelayInput(e.currentTarget.value)}
            />
            <input
              class="rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
              placeholder="Join token (optional — lock session)"
              value={tokenInput()}
              onInput={(e) => setTokenInput(e.currentTarget.value)}
            />
            <button
              class="rounded bg-fill-accent px-3 py-1.5 text-xs font-medium text-text-on-accent disabled:opacity-50"
              disabled={loading()}
              onClick={startShare}
            >
              {loading() ? "Starting..." : "Start Sharing"}
            </button>
          </div>
        }
      >
        {/* Active session */}
        <div class="flex flex-col gap-2 rounded border border-border-base bg-background-soft p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-text-dimmed">Share Code</span>
              <span class="font-mono font-bold tracking-wider text-text-accent">{status().code}</span>
            </div>
            <button
              class="rounded px-2 py-1 text-xs font-medium text-text-accent hover:bg-fill-hover"
              onClick={copyCode}
            >
              {copied() ? "Copied!" : "Copy"}
            </button>
          </div>

          <Show when={status().relay}>
            <div class="text-xs text-text-dimmed">
              Mode: <span class="text-text-base">relay</span> — {status().relay}
            </div>
          </Show>
          <Show when={!status().relay}>
            <div class="text-xs text-text-dimmed">
              Mode: <span class="text-text-base">LAN</span> — {status().hostname}:{status().port}
            </div>
          </Show>

          {/* Lock indicator */}
          <div class="text-xs">
            <Show
              when={status().locked}
              fallback={<span class="text-text-dimmed">Unlocked — anyone with the code can join</span>}
            >
              <span class="font-medium text-text-warning">Locked — join token required</span>
            </Show>
          </div>

          <Show when={status().locked && (status() as any).token}>
            <div class="flex items-center justify-between p-2 rounded bg-surface-weak">
              <div class="min-w-0">
                <div class="text-[10px] text-text-dimmed">Join Token</div>
                <div class="text-xs font-mono font-bold text-text-accent truncate">{(status() as any).token}</div>
              </div>
              <button
                class="text-xs text-text-accent hover:underline shrink-0"
                onClick={() => navigator.clipboard.writeText((status() as any).token || "")}
              >
                Copy
              </button>
            </div>
          </Show>

          <div class="mt-1 text-xs font-medium text-text-dimmed">
            Participants ({(status().participants ?? []).length})
          </div>
          <For
            each={status().participants ?? []}
            fallback={<div class="text-xs text-text-dimmed">No one connected yet</div>}
          >
            {(p) => {
              const av = avatar(p.id, p.name)
              return (
                <div class="flex items-center justify-between rounded bg-background-hover px-2 py-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <div class="relative shrink-0">
                      <div
                        class="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                        style={{ "background-color": av.color }}
                        title={p.name}
                      >
                        {av.initials}
                      </div>
                      <span
                        class={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-background-base ${
                          p.presence === "away" ? "bg-yellow-400" : "bg-green-500"
                        }`}
                        title={p.presence === "away" ? "Away" : "Online"}
                      />
                    </div>
                    <div class="flex flex-col min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs truncate">{p.name}</span>
                        <span
                          class={`text-[9px] px-1 rounded shrink-0 ${
                            p.role === "editor"
                              ? "bg-fill-accent text-text-on-accent"
                              : "bg-fill-subtle text-text-dimmed"
                          }`}
                        >
                          {p.role ?? "viewer"}
                        </span>
                      </div>
                      <Show when={p.session}>
                        <span class="text-[9px] text-text-dimmed font-mono">viewing {p.session?.slice(0, 8)}</span>
                      </Show>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button class="text-xs text-text-accent hover:underline" onClick={() => toggleRole(p)}>
                      {p.role === "editor" ? "Demote" : "Promote"}
                    </button>
                    <button class="text-xs text-text-critical hover:underline" onClick={() => kickParticipant(p.id)}>
                      Kick
                    </button>
                  </div>
                </div>
              )
            }}
          </For>

          {/* Chat area */}
          <div class="mt-2 flex flex-col gap-1">
            <Show
              when={sock() && wsState() !== "closed"}
              fallback={
                <div class="flex flex-col gap-1">
                  <Show when={wsState() === "connecting"}>
                    <div class="text-xs text-text-dimmed">Connecting...</div>
                  </Show>
                  <Show when={wsState() === "reconnecting"}>
                    <div class="text-xs text-text-warning">
                      Reconnecting{sock()?.store.retries ? ` (attempt ${sock()!.store.retries})` : ""}...
                    </div>
                  </Show>
                  <button
                    class="rounded bg-fill-subtle px-2 py-1 text-xs text-text-dimmed hover:bg-fill-hover"
                    onClick={connectWs}
                    disabled={wsState() === "connecting"}
                  >
                    Open chat
                  </button>
                </div>
              }
            >
              {/* Connection status */}
              <div class="flex items-center gap-1 text-xs">
                <span class="inline-block h-2 w-2 rounded-full bg-green-500" />
                <span class="text-text-dimmed">Connected</span>
              </div>
              <Show when={sock()?.store.hostSession}>
                {(id) => {
                  const title = () => sync.session.get(id())?.title ?? id().slice(0, 8)
                  return (
                    <div class="text-xs text-text-dimmed">
                      Host viewing: <span class="text-text-base">{title()}</span>
                    </div>
                  )
                }}
              </Show>
              <div class="max-h-40 overflow-y-auto rounded border border-border-base bg-background-base p-2">
                <For each={chat} fallback={<div class="text-xs text-text-dimmed">No messages yet</div>}>
                  {(m) => (
                    <div class="text-xs">
                      <span class="font-medium text-text-accent">{m.name}: </span>
                      <span>{m.text}</span>
                    </div>
                  )}
                </For>
              </div>
              <div class="flex gap-1">
                <input
                  class="min-w-0 flex-1 rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
                  placeholder="Say something..."
                  value={input()}
                  onInput={(e) => setInput(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendChat()}
                />
                <button
                  class="rounded bg-fill-accent px-2 py-1 text-xs font-medium text-text-on-accent"
                  onClick={sendChat}
                >
                  Send
                </button>
              </div>
            </Show>
          </div>

          <button
            class="mt-1 rounded border border-border-critical px-3 py-1 text-xs text-text-critical hover:bg-fill-critical-subtle disabled:opacity-50"
            disabled={loading()}
            onClick={stopShare}
          >
            {loading() ? "Stopping..." : "Stop Sharing"}
          </button>
        </div>
      </Show>

      {/* Join section (for local testing / non-desktop joining) */}
      <div class="flex flex-col gap-2 rounded border border-border-weak bg-background-soft p-3">
        <div class="text-xs font-medium text-text-dimmed">Join a session</div>
        <input
          class="rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
          placeholder="Session code"
          value={joinCode()}
          onInput={(e) => setJoinCode(e.currentTarget.value)}
        />
        <input
          class="rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
          placeholder="Your name (optional)"
          value={joinName()}
          onInput={(e) => setJoinName(e.currentTarget.value)}
        />
        <input
          class="rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
          placeholder="Join token (if session is locked)"
          value={joinToken()}
          onInput={(e) => setJoinToken(e.currentTarget.value)}
        />
        <div class="text-xs text-text-dimmed">
          Use <code class="font-mono">crimecode share join --relay &lt;url&gt; --code &lt;code&gt;</code> from the
          terminal to connect to a remote session.
        </div>
      </div>
    </div>
  )
}
