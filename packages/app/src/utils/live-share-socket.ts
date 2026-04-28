// Live Share WebSocket connection helper.
// Handles connect, app-level ping/pong heartbeat, exponential-backoff reconnect,
// participant tracking, and pluggable message handler.

import { createStore, reconcile } from "solid-js/store"

export type State = "idle" | "connecting" | "connected" | "reconnecting" | "paused" | "closed"

export interface Participant {
  id: string
  name: string
  joined: number
  session?: string | null
  role?: "viewer" | "editor"
  presence?: "online" | "away"
}

export interface Msg {
  type: string
  [k: string]: unknown
}

export type Role = "viewer" | "editor"

export interface Opts {
  url: () => string | null
  onMessage?: (msg: Msg) => void
  onState?: (s: State) => void
  onRoleChange?: (next: Role, prev: Role) => void
  maxRetries?: number
  baseDelay?: number
  pingInterval?: number
}

export interface Store {
  state: State
  id: string | null
  name: string | null
  code: string | null
  error: string | null
  participants: Participant[]
  retries: number
  hostSession: string | null
  events: unknown[]
}

export interface Handle {
  store: Store
  send: (msg: Msg) => boolean
  close: () => void
  reconnect: () => void
  setSession: (id: string | null) => void
  setPresence: (status: "online" | "away") => void
}

const MAX = Number.POSITIVE_INFINITY
const BASE = 500
const PING = 15_000
const CAP = 30_000
const EVT_MAX = 200
// Host-gone watchdog: if we don't receive a `participants` snapshot
// containing the host (or any host-only event) within this window, we
// assume the host has crashed without sending `stopped` and we close the
// socket. The relay's own pong-timeout is between us and the relay, not
// us and the host — without this watchdog a host crash leaves us stuck
// with a "connected" socket forever.
const HOST_QUIET_THRESHOLD_MS = 60_000

export function createLiveShareSocket(opts: Opts): Handle {
  const max = opts.maxRetries ?? MAX
  const base = opts.baseDelay ?? BASE
  const pingMs = opts.pingInterval ?? PING

  const [store, set] = createStore<Store>({
    state: "idle",
    id: null,
    name: null,
    code: null,
    error: null,
    participants: [],
    retries: 0,
    hostSession: null,
    events: [],
  })

  let ws: WebSocket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let lastPong = Date.now()
  // Tracks the last time we saw evidence the host is still alive: a fresh
  // event from them, a `participants` list including their id, or a
  // `relay_*` greeting. Reset by the watchdog after each verified beat.
  let lastHostBeat = Date.now()

  function go(s: State) {
    set("state", s)
    opts.onState?.(s)
  }

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
  }

  function startWatchdog() {
    clearWatchdog()
    lastHostBeat = Date.now()
    watchdogTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastHostBeat > HOST_QUIET_THRESHOLD_MS) {
        // Host gone: surface to the user, then close gracefully so the
        // reconnect loop kicks in. If the host comes back the next
        // `joined` / `participants` message will reset lastHostBeat.
        set("error", "host appears offline (no activity for 60s)")
        try {
          ws.close(1000, "host gone")
        } catch {
          /* ignore */
        }
      }
    }, HOST_QUIET_THRESHOLD_MS / 4)
  }

  function startPing() {
    clearPing()
    lastPong = Date.now()
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPong > pingMs * 3) {
        try {
          ws.close(4000, "heartbeat timeout")
        } catch {}
        return
      }
      try {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }))
      } catch {}
    }, pingMs)
  }

  function applyParticipants(list: Participant[]) {
    const self = store.id
    if (self) {
      const prev = store.participants.find((p) => p.id === self)?.role ?? "viewer"
      const next = list.find((p) => p.id === self)?.role ?? "viewer"
      if (prev !== next) opts.onRoleChange?.(next, prev)
    }
    set("participants", reconcile(list, { key: "id" }))
  }

  function patchParticipant(p: Participant) {
    const cur = store.participants
    if (cur.some((x) => x.id === p.id)) return
    set("participants", [...cur, p])
  }

  function dropParticipant(id: string) {
    set(
      "participants",
      store.participants.filter((p) => p.id !== id),
    )
  }

  function trackHostSession(ev: unknown) {
    const t = (ev as { type?: string })?.type
    if (t !== "session.updated" && t !== "session.created") return
    const info = (ev as { properties?: { info?: { id?: string } } })?.properties?.info
    if (info?.id) set("hostSession", info.id)
  }

  function recordEvent(ev: unknown) {
    const next = store.events.length >= EVT_MAX ? store.events.slice(1) : store.events.slice()
    next.push(ev)
    set("events", next)
    trackHostSession(ev)
  }

  function connect() {
    clearRetry()
    const url = opts.url()
    if (!url) {
      set({ state: "idle", error: "no url" })
      return
    }
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
    go(store.retries > 0 ? "reconnecting" : "connecting")
    set("error", null)

    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch (e) {
      set("error", String(e))
      scheduleRetry()
      return
    }
    ws = sock

    sock.onopen = () => {
      set({ retries: 0 })
      lastPong = Date.now()
      lastHostBeat = Date.now()
      go("connected")
      startPing()
      startWatchdog()
    }

    sock.onmessage = (evt) => {
      lastPong = Date.now()
      let msg: Msg
      try {
        msg = JSON.parse(evt.data as string) as Msg
      } catch {
        return
      }

      // Any message from the host counts as proof of life for the watchdog.
      // The relay's own pings are filtered (they originate from the relay,
      // not the host) so a relay-up + host-down state still trips the
      // watchdog after the threshold.
      if (msg.type !== "ping" && msg.type !== "pong") {
        lastHostBeat = Date.now()
      }

      if (msg.type === "pong") return
      if (msg.type === "ping") {
        try {
          sock.send(JSON.stringify({ type: "pong", ts: msg.ts }))
        } catch {}
        return
      }

      if (msg.type === "hello") {
        set({ id: msg.id as string, name: msg.name as string, code: msg.code as string })
      } else if (msg.type === "relay_connected") {
        // Relay greeting (client role) — synthesize a hello so UI gets id/code/name
        set({ id: msg.id as string, name: msg.name as string, code: msg.code as string })
      } else if (msg.type === "host_paused") {
        go("paused")
      } else if (msg.type === "registered") {
        const list = (msg.clients ?? []) as Participant[]
        applyParticipants(list.map((c) => ({ id: c.id, name: c.name, joined: Date.now() })))
      } else if (msg.type === "joined" || msg.type === "relay_client_joined") {
        patchParticipant({ id: msg.id as string, name: (msg.name as string) ?? "anonymous", joined: Date.now() })
      } else if (msg.type === "left" || msg.type === "relay_client_left") {
        dropParticipant(msg.id as string)
      } else if (msg.type === "participants") {
        applyParticipants((msg.list ?? []) as Participant[])
      } else if (msg.type === "kicked") {
        set("error", (msg.reason as string) ?? "kicked")
        stopped = true
      } else if (msg.type === "stopped") {
        stopped = true
      } else if (msg.type === "event") {
        recordEvent(msg.payload)
      } else if (msg.type === "snapshot") {
        const list = (msg.events ?? []) as unknown[]
        set("events", list.slice(-EVT_MAX))
        for (const ev of list) trackHostSession(ev)
      } else if (msg.type === "presence_update") {
        const id = msg.id as string
        const status = msg.status as "online" | "away"
        const idx = store.participants.findIndex((p) => p.id === id)
        if (idx >= 0) set("participants", idx, "presence", status)
      }

      opts.onMessage?.(msg)
    }

    sock.onerror = () => {
      set("error", "socket error")
    }

    sock.onclose = (evt) => {
      clearPing()
      clearWatchdog()
      ws = null
      if (stopped || evt.code === 1000 || evt.code === 4001 || evt.code === 4002) {
        go("closed")
        return
      }
      // Auth/permission failures: do not retry; surface reason
      if (evt.code === 4003 || evt.code === 1008) {
        set("error", evt.reason || "authentication failed (invalid or missing join token)")
        stopped = true
        go("closed")
        return
      }
      scheduleRetry()
    }
  }

  function scheduleRetry() {
    if (stopped) return
    if (store.retries >= max) {
      go("closed")
      return
    }
    const next = store.retries + 1
    set("retries", next)
    const delay = Math.min(base * 2 ** (Math.min(next, 8) - 1), CAP) + Math.random() * 250
    go("reconnecting")
    retryTimer = setTimeout(connect, delay)
  }

  connect()

  return {
    store,
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(msg))
        return true
      } catch {
        return false
      }
    },
    close() {
      stopped = true
      clearPing()
      clearRetry()
      clearWatchdog()
      if (ws) {
        try {
          ws.close(1000, "client closed")
        } catch {}
        ws = null
      }
      go("closed")
    },
    reconnect() {
      stopped = false
      set({ retries: 0 })
      connect()
    },
    setSession(id) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ type: "presence", session: id }))
      } catch {}
    },
    setPresence(status) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const self = store.id
      if (self) {
        const idx = store.participants.findIndex((p) => p.id === self)
        if (idx >= 0) set("participants", idx, "presence", status)
      }
      try {
        ws.send(JSON.stringify({ type: "presence_update", status }))
      } catch {}
    },
  }
}
