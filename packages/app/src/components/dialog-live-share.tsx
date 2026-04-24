import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createSignal, For, onCleanup, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { useLiveShareState } from "@/context/liveshare-state"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLanguage } from "@/context/language"
import { createLiveShareSocket, type Handle as SocketHandle } from "@/utils/live-share-socket"
import { createScreenShare, type Handle as ScreenHandle } from "@/utils/screen-share"
import { withAuthHeaders } from "@/utils/auth-fetch"
import { ScreenSourcePicker } from "./screen-source-picker"
import { ScreenViewer } from "./screen-viewer"
import qrcode from "qrcode-generator"

// Built-in presets for relay servers. Edit RELAY_PRESETS to add hosted defaults.
// See RELAY-DEPLOY.md to spin one up on Fly.io / Cloudflare Tunnel / Docker.
const RELAY_PRESETS: { label: string; url: string }[] = [
  { label: "LAN only", url: "" },
  { label: "Fly (jolly)", url: "wss://crimecode-relay-jolly.fly.dev" },
  { label: "Cloudflare tunnel hint", url: "wss://YOUR-TUNNEL.trycloudflare.com" },
]

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

// apiGet/apiPost used to be top-level helpers that called `fetch` directly,
// which meant every /liveshare/* request went out without an Authorization
// header and got a 401 back from the backend (see v2.16.0 diagnostic
// report). They're now closures built inside DialogLiveShare below so they
// can read the active server's credentials through useServer().

// Stable per-id avatar color and initials.
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

function buildShareUri(code: string, relay: string | null | undefined, token: string | null | undefined) {
  const params = new URLSearchParams()
  params.set("code", code)
  if (relay) params.set("relay", relay)
  if (token) params.set("token", token)
  return `opencode-share://join?${params.toString()}`
}

function qrSvg(text: string, size = 168) {
  const qr = qrcode(0, "M")
  qr.addData(text)
  qr.make()
  const cells = qr.getModuleCount()
  const cell = size / cells
  let rects = ""
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      if (qr.isDark(r, c)) {
        rects += `<rect x="${(c * cell).toFixed(2)}" y="${(r * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="black"/>`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><g>${rects}</g></svg>`
}

export function DialogLiveShare() {
  const dialog = useDialog()
  const language = useLanguage()
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
  const navigate = useNavigate()
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
  const [copiedToken, setCopiedToken] = createSignal(false)
  const [sock, setSock] = createSignal<SocketHandle | null>(null)
  const wsState = () => sock()?.store.state ?? "disconnected"
  const [tab, setTab] = createSignal<"host" | "join">("host")
  const [follow, setFollow] = createSignal(false)
  const [lastFollowed, setLastFollowed] = createSignal<string | null>(null)
  const [screen, setScreen] = createSignal<ScreenHandle | null>(null)
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [showQr, setShowQr] = createSignal(false)
  const screenAvail = () =>
    Boolean((window as unknown as { api?: { getScreenSources?: unknown } }).api?.getScreenSources)

  const qrMarkup = createMemo(() => {
    const s = status()
    if (!s.active || !s.code) return ""
    const tk = (s as any).token || tokenInput()
    return qrSvg(buildShareUri(s.code, s.relay, tk), 168)
  })

  // When follow-host is on, navigate to the host's active session as it changes.
  createEffect(() => {
    if (!follow()) return
    const target = sock()?.store.hostSession
    if (!target || target === lastFollowed()) return
    setLastFollowed(target)
    const dir = base64Encode("@liveshare")
    navigate(`/${dir}/session/${target}`)
  })

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

  const interval = setInterval(refresh, 5000)
  onCleanup(() => {
    clearInterval(interval)
    screen()?.stopHost()
    screen()?.closeRemote()
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

  createEffect(() => {
    if (server.current) {
      refresh()
    }
  })

  async function startShare() {
    setLoading(true)
    try {
      const relay = relayInput().trim() || undefined
      // Always require a token (relay enforces >=8 chars). Auto-generate if empty.
      let token = tokenInput().trim()
      if (token.length < 8) {
        token = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
        setTokenInput(token)
      }
      const body: Record<string, unknown> = { token }
      if (relay) body.relay = relay
      const d = await apiPost(base(), "/liveshare/start", body)
      if (d.code || !d.error) await refresh()
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

  function copyToken() {
    const t = (status() as any).token || tokenInput()
    if (!t) return
    navigator.clipboard.writeText(t).then(() => {
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 1500)
    })
  }

  function openSocket(url: string) {
    sock()?.close()
    screen()?.stopHost()
    screen()?.closeRemote()
    setScreen(null)
    const h = createLiveShareSocket({
      url: () => url,
      onRoleChange: (next) => {
        showToast({
          title: next === "editor" ? "You were promoted to editor" : "You are now a viewer",
          variant: next === "editor" ? "success" : "default",
        })
      },
      onMessage: (msg) => {
        // Forward WebRTC signaling to the screen-share manager.
        if (typeof msg.type === "string" && msg.type.startsWith("screen.")) {
          screen()?.handle(msg)
          return
        }
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
    const sh = createScreenShare(
      () => h,
      () => h.store.id,
    )
    setScreen(sh)
  }

  function connectWs() {
    const s = status()
    if (!s.active || !s.code) return
    const relay = s.relay
    const name = joinName() || "viewer"
    const token = joinToken().trim()
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ""
    const url = relay
      ? `${relay.replace(/^http/, "ws")}/?role=client&code=${s.code}&name=${encodeURIComponent(name)}${tokenParam}`
      : `ws://127.0.0.1:${s.port}/?code=${s.code}&name=${encodeURIComponent(name)}`
    openSocket(url)
  }

  function sendChat() {
    const text = input().trim()
    if (!text) return
    sock()?.send({ type: "chat", text })
    setInput("")
  }

  async function joinSession() {
    const code = joinCode().trim().toUpperCase()
    if (!code) return

    setLoading(true)
    sock()?.close()

    const relay = relayInput().trim()
    const name = joinName().trim() || "guest"
    const token = joinToken().trim()
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ""

    let url: string
    if (relay) {
      const wsRelay = relay.replace(/^http/, "ws").replace(/\/+$/, "")
      url = `${wsRelay}/?role=client&code=${code}&name=${encodeURIComponent(name)}${tokenParam}`
    } else {
      try {
        const res = await fetch(`http://127.0.0.1:3747/invite/${code}`)
        if (!res.ok) {
          setLoading(false)
          return
        }
        url = `ws://127.0.0.1:3747?role=client&code=${code}&name=${encodeURIComponent(name)}${tokenParam}`
      } catch {
        setLoading(false)
        return
      }
    }

    openSocket(url)
    setLoading(false)
  }

  return (
    <Dialog title="Live Share">
      <div class="flex flex-col gap-4 p-5 min-w-[400px] max-h-[80vh] overflow-y-auto">
        <div class="flex gap-2 border-b border-border-base pb-2">
          <button
            class={`px-3 py-1.5 text-sm rounded-t ${
              tab() === "host" ? "bg-fill-accent text-text-on-accent" : "text-text-secondary hover:bg-fill-hover"
            }`}
            onClick={() => setTab("host")}
          >
            Host Session
          </button>
          <button
            class={`px-3 py-1.5 text-sm rounded-t ${
              tab() === "join" ? "bg-fill-accent text-text-on-accent" : "text-text-secondary hover:bg-fill-hover"
            }`}
            onClick={() => setTab("join")}
          >
            Join Session
          </button>
        </div>

        <Show when={tab() === "host"}>
          <Show
            when={status().active}
            fallback={
              <div class="flex flex-col gap-3">
                <div class="text-sm text-text-secondary">
                  Start a Live Share session to collaborate with others in real-time.
                </div>
                <input
                  class="rounded border border-border-base bg-background-input px-3 py-2 text-sm outline-none focus:border-border-focus"
                  placeholder="Relay URL (optional, e.g. https://gotta-distributions-expiration-elvis.trycloudflare.com)"
                  value={relayInput()}
                  onInput={(e) => setRelayInput(e.currentTarget.value)}
                />
                <div class="flex flex-wrap gap-1.5 -mt-1">
                  <For each={RELAY_PRESETS}>
                    {(p) => (
                      <button
                        type="button"
                        class="text-xs px-2 py-0.5 rounded border border-border-base text-text-secondary hover:bg-fill-hover"
                        onClick={() => setRelayInput(p.url)}
                        title={p.url || "Clear (LAN only)"}
                      >
                        {p.label}
                      </button>
                    )}
                  </For>
                </div>
                <input
                  class="rounded border border-border-base bg-background-input px-3 py-2 text-sm outline-none focus:border-border-focus"
                  placeholder="Join token (optional - lock session)"
                  value={tokenInput()}
                  onInput={(e) => setTokenInput(e.currentTarget.value)}
                />
                <Button variant="primary" onClick={startShare} disabled={loading()}>
                  {loading() ? "Starting..." : "Start Sharing"}
                </Button>
              </div>
            }
          >
            <div class="flex flex-col gap-3">
              <div class="flex items-center justify-between p-3 rounded bg-surface-weak">
                <div>
                  <div class="text-xs text-text-dimmed">Share Code</div>
                  <div class="text-xl font-mono font-bold text-text-accent tracking-wider">{status().code}</div>
                </div>
                <Button variant="ghost" size="small" onClick={copyCode}>
                  {copied() ? "Copied!" : "Copy"}
                </Button>
              </div>

              <Show when={status().relay}>
                <div class="text-xs text-text-dimmed">Mode: relay ({status().relay})</div>
              </Show>

              <div class="text-xs">
                <Show
                  when={status().locked}
                  fallback={<span class="text-text-dimmed">Unlocked - anyone with code can join</span>}
                >
                  <span class="text-text-warning">Locked - token required to join</span>
                </Show>
              </div>

              <Show when={status().locked && ((status() as any).token || tokenInput())}>
                <div class="flex items-center justify-between p-3 rounded bg-surface-weak">
                  <div class="min-w-0">
                    <div class="text-xs text-text-dimmed">Join Token</div>
                    <div class="text-sm font-mono font-bold text-text-accent tracking-wider truncate">
                      {(status() as any).token || tokenInput()}
                    </div>
                  </div>
                  <Button variant="ghost" size="small" onClick={copyToken}>
                    {copiedToken() ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </Show>

              <div class="flex items-center justify-between">
                <Button variant="ghost" size="small" onClick={() => setShowQr(!showQr())}>
                  {showQr() ? "Hide QR" : "Show QR code"}
                </Button>
                <Show when={showQr()}>
                  <span class="text-[10px] text-text-dimmed">Scan to join</span>
                </Show>
              </div>
              <Show when={showQr()}>
                <div class="flex flex-col items-center gap-2 p-3 rounded bg-white">
                  <div class="text-text-base" innerHTML={qrMarkup()} />
                </div>
              </Show>

              <div class="text-sm font-medium text-text-dimmed">
                Participants ({status().participants?.length ?? 0})
              </div>
              <For
                each={status().participants ?? []}
                fallback={<div class="text-xs text-text-dimmed">No one connected</div>}
              >
                {(p) => {
                  const a = avatar(p.id, p.name)
                  return (
                    <div class="flex items-center justify-between p-2 rounded bg-surface-weak">
                      <div class="flex items-center gap-2">
                        <div class="relative shrink-0">
                          <div
                            class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
                            style={{ "background-color": a.color }}
                          >
                            {a.initials}
                          </div>
                          <span
                            class={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-background-base ${
                              p.presence === "away" ? "bg-yellow-400" : "bg-green-500"
                            }`}
                            title={p.presence === "away" ? "Away" : "Online"}
                          />
                        </div>
                        <div class="flex flex-col">
                          <div class="flex items-center gap-2">
                            <span class="text-sm">{p.name}</span>
                            <span
                              class={`text-[10px] px-1.5 py-0.5 rounded ${
                                p.role === "editor"
                                  ? "bg-fill-accent text-text-on-accent"
                                  : "bg-fill-subtle text-text-dimmed"
                              }`}
                            >
                              {p.role ?? "viewer"}
                            </span>
                          </div>
                          <Show when={p.session}>
                            <span class="text-[10px] text-text-dimmed font-mono">viewing {p.session?.slice(0, 8)}</span>
                          </Show>
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        <button class="text-xs text-text-accent hover:underline" onClick={() => toggleRole(p)}>
                          {p.role === "editor" ? "Demote" : "Promote"}
                        </button>
                        <button
                          class="text-xs text-text-critical hover:underline"
                          onClick={() => kickParticipant(p.id)}
                        >
                          Kick
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>

              <div class="mt-2 p-3 rounded border border-border-base bg-surface-weak">
                <div class="text-xs text-text-dimmed mb-2">Chat</div>
                <div class="max-h-32 overflow-y-auto rounded bg-background-base p-2 mb-2">
                  <For each={chat} fallback={<div class="text-xs text-text-dimmed">No messages</div>}>
                    {(m) => {
                      const a = avatar(m.from, m.name)
                      return (
                        <div class="text-xs mb-1">
                          <span class="font-medium" style={{ color: a.color }}>
                            {m.name}:{" "}
                          </span>
                          <span>{m.text}</span>
                        </div>
                      )
                    }}
                  </For>
                </div>
                <div class="flex gap-2">
                  <input
                    class="flex-1 rounded border border-border-base bg-background-input px-2 py-1 text-xs outline-none focus:border-border-focus"
                    placeholder="Type a message..."
                    value={input()}
                    onInput={(e) => setInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendChat()}
                  />
                  <Button variant="primary" size="small" onClick={sendChat}>
                    Send
                  </Button>
                </div>
              </div>

              <Button variant="ghost" class="text-text-critical border border-border-critical" onClick={stopShare}>
                {loading() ? "Stopping..." : "Stop Sharing"}
              </Button>
            </div>
          </Show>
        </Show>

        <Show when={tab() === "join"}>
          <div class="flex flex-col gap-3">
            <div class="text-sm text-text-secondary">Enter the session code and relay URL shared by the host.</div>
            <input
              class="rounded border border-border-base bg-background-input px-3 py-2 text-sm outline-none focus:border-border-focus"
              placeholder="Session code"
              value={joinCode()}
              onInput={(e) => setJoinCode(e.currentTarget.value)}
            />
            <input
              class="rounded border border-border-base bg-background-input px-3 py-2 text-sm outline-none focus:border-border-focus"
              placeholder="Relay URL (e.g. wss://example.ngrok-free.app)"
              value={relayInput()}
              onInput={(e) => setRelayInput(e.currentTarget.value)}
            />
            <input
              class="rounded border border-border-base bg-background-input px-3 py-2 text-sm outline-none focus:border-border-focus"
              placeholder="Your name (optional)"
              value={joinName()}
              onInput={(e) => setJoinName(e.currentTarget.value)}
            />
            <input
              class="rounded border border-border-base bg-background-input px-3 py-2 text-sm outline-none focus:border-border-focus"
              placeholder="Join token (required - ask the host)"
              value={joinToken()}
              onInput={(e) => setJoinToken(e.currentTarget.value)}
            />
            <Button
              variant="primary"
              onClick={joinSession}
              disabled={loading() || !joinCode().trim() || !joinToken().trim()}
            >
              {loading() ? "Joining..." : "Join Session"}
            </Button>
            <Show when={sock()?.store.error}>
              <div class="text-xs text-text-critical">{sock()?.store.error}</div>
            </Show>
            <Show when={wsState() === "connected"}>
              <div class="text-sm text-text-success">Connected to session!</div>
              <label class="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={follow()} onChange={(e) => setFollow(e.currentTarget.checked)} />
                <span>Follow host</span>
                <Show when={sock()?.store.hostSession}>
                  {(id) => {
                    const title = () => sync.session.get(id())?.title ?? id().slice(0, 8)
                    return <span class="text-text-dimmed">→ {title()}</span>
                  }}
                </Show>
              </label>
            </Show>
            <Show when={wsState() === "connecting"}>
              <div class="text-sm text-text-warning">Connecting...</div>
            </Show>
            <Show when={wsState() === "reconnecting"}>
              <div class="text-sm text-text-warning">
                Reconnecting{sock()?.store.retries ? ` (attempt ${sock()!.store.retries})` : ""}...
              </div>
            </Show>
            <Show when={wsState() === "paused"}>
              <div class="text-sm text-text-warning">Host disconnected, waiting for resume...</div>
            </Show>
            <Show when={wsState() === "closed" && sock()?.store.error}>
              <div class="text-sm text-text-critical">Disconnected: {sock()!.store.error}</div>
            </Show>
            <div class="text-xs text-text-dimmed">Note: WebSocket connections require the relay URL from the host.</div>
          </div>
        </Show>

        <Show when={!server.current}>
          <div class="text-sm text-text-critical">Connect to a server first to use Live Share.</div>
        </Show>

        <Show when={wsState() === "connected" && screenAvail()}>
          <div class="border-t border-border-base pt-3 mt-1 flex flex-col gap-2">
            <div class="text-sm font-medium">Screen Share</div>
            <Show
              when={screen()?.state.active && screen()?.state.role === "host"}
              fallback={
                <Button variant="primary" size="small" onClick={() => setPickerOpen(true)} disabled={!screen()}>
                  Share My Screen
                </Button>
              }
            >
              <div class="flex items-center justify-between gap-2 p-2 rounded bg-surface-weak">
                <div class="text-xs">
                  Sharing <span class="font-mono">{screen()?.state.sourceName}</span> →{" "}
                  {screen()?.state.peers.length ?? 0} viewer(s)
                </div>
                <Button variant="ghost" size="small" onClick={() => screen()?.stopHost()}>
                  Stop
                </Button>
              </div>
            </Show>
            <Show when={screen()?.state.error}>
              <div class="text-xs text-text-critical">{screen()!.state.error}</div>
            </Show>
          </div>
        </Show>
      </div>

      <ScreenSourcePicker
        open={pickerOpen()}
        onClose={() => setPickerOpen(false)}
        onPick={(p) => {
          setPickerOpen(false)
          void screen()?.startHost(p.source.id, p.source.name, {
            quality: p.quality,
            audio: p.audio,
            fps: p.fps,
          })
        }}
      />

      <ScreenViewer
        stream={screen()?.state.remoteStream ?? null}
        fromName={screen()?.state.remoteFromName ?? null}
        onClose={() => screen()?.closeRemote()}
      />
    </Dialog>
  )
}

let dialogRef: { open: () => void } | null = null

export function openLiveShareDialog() {
  dialogRef?.open()
}
