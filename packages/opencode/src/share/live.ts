import crypto from "crypto"
import fs from "fs/promises"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Log } from "../util/log"

const log = Log.create({ service: "share.live" })

// Base62 alphabet for URL-safe codes
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function b62(len: number): string {
  const bytes = crypto.randomBytes(len)
  return Array.from(bytes, (b) => B62[b % 62]).join("")
}

// Code format: <16 base62 random><8 hex timestamp-window>
// The timestamp window is floor(Date.now() / 300000) encoded as 8 hex chars.
// Codes are valid for the current 5-minute window only.
const WINDOW = 5 * 60 * 1000

function makeCode(): string {
  const rand = b62(16)
  const win = Math.floor(Date.now() / WINDOW)
    .toString(16)
    .padStart(8, "0")
  return `${rand}${win}`.toUpperCase()
}

function parseCode(raw: string): { rand: string; win: number } | null {
  if (raw.length !== 24) return null
  const rand = raw.slice(0, 16)
  const win = parseInt(raw.slice(16), 16)
  if (isNaN(win)) return null
  return { rand, win }
}

function codeValid(secret: string, provided: string): boolean {
  if (!secret || !provided) return false
  const p = parseCode(provided.toUpperCase())
  if (!p) return false
  const s = parseCode(secret.toUpperCase())
  if (!s) return false
  // Same random part, and window is current or within 1 window tolerance
  if (p.rand !== s.rand) return false
  const now = Math.floor(Date.now() / WINDOW)
  return Math.abs(p.win - now) <= 1
}

export namespace LiveShare {
  // --- Protocol types ---

  export type Msg =
    | { type: "event"; payload: unknown }
    | { type: "snapshot"; events: unknown[] }
    | { type: "file"; file: string; event: string }
    | { type: "file_content"; file: string; content: string; event: string }
    | { type: "chat"; from: string; name: string; text: string; ts: number }
    | { type: "joined"; id: string; name: string }
    | { type: "left"; id: string; name: string }
    | { type: "kicked"; reason: string }
    | { type: "stopped" }
    | { type: "participants"; list: Participant[] }
    | { type: "hello"; id: string; name: string; code: string }
    | { type: "presence"; session: string | null }

  export type Role = "viewer" | "editor"

  export interface Participant {
    id: string
    name: string
    joined: number
    session?: string | null
    role?: Role
  }

  // --- Server (Host) side ---

  interface Client {
    id: string
    name: string
    joined: number
    ws: WebSocket
    session?: string | null
    role: Role
  }

  // Message types a non-editor (viewer) is allowed to send. Anything else
  // is silently dropped at the host. This is the security boundary that
  // makes "viewer-only" meaningful.
  const VIEWER_ALLOWED = new Set([
    "chat",
    "presence",
    "ping",
    "pong",
    "screen.offer",
    "screen.answer",
    "screen.ice",
    "screen.start",
    "screen.stop",
    "screen.request",
  ])
  const SIGNAL = new Set([
    "screen.offer",
    "screen.answer",
    "screen.ice",
    "screen.start",
    "screen.stop",
    "screen.request",
  ])

  interface Hub {
    code: string
    port: number
    hostname: string
    relay: string | null
    token: string
    key: string
    clients: Map<string, Client>
    server: ReturnType<typeof Bun.serve> | null
    relayWs: WebSocket | null
    unsubs: (() => void)[]
    reconnecting: boolean
    stopped: boolean
    history: unknown[]
    // Roles persist by participant name across reconnects. Anyone joining
    // with a name previously promoted to "editor" rejoins as editor.
    roles: Map<string, Role>
  }

  let hub: Hub | null = null

  const HISTORY_MAX = 200

  // Event types worth replaying for catch-up. Lifecycle events like
  // server.connected / server.instance.disposed would cause clients to
  // refresh and discard the snapshot, so they are filtered out.
  const REPLAY = new Set([
    "session.created",
    "session.updated",
    "session.status",
    "session.diff",
    "message.updated",
    "todo.updated",
    "project.updated",
  ])

  function record(payload: unknown) {
    if (!hub) return
    const t = (payload as { type?: string })?.type
    if (!t || !REPLAY.has(t)) return
    hub.history.push(payload)
    if (hub.history.length > HISTORY_MAX) hub.history.splice(0, hub.history.length - HISTORY_MAX)
  }

  function snapshot(): Msg {
    return { type: "snapshot", events: hub ? hub.history.slice() : [] }
  }

  // Coalesce high-frequency message.part.delta events to reduce broadcast load.
  // Keyed by `${sessionID}:${messageID}:${partID}:${field}`; deltas concatenate.
  const COALESCE_MS = 30
  const pending = new Map<string, { payload: any; timer: ReturnType<typeof setTimeout> }>()

  function flushDelta(key: string) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    clearTimeout(entry.timer)
    broadcast({ type: "event", payload: entry.payload })
  }

  function flushAllDeltas() {
    for (const key of [...pending.keys()]) flushDelta(key)
  }

  function coalesce(payload: any): boolean {
    if (payload?.type !== "message.part.delta") return false
    const p = payload.properties
    if (!p) return false
    const key = `${p.sessionID}:${p.messageID}:${p.partID}:${p.field}`
    const cur = pending.get(key)
    if (cur) {
      cur.payload.properties.delta += p.delta
      return true
    }
    const timer = setTimeout(() => flushDelta(key), COALESCE_MS)
    pending.set(key, { payload: { ...payload, properties: { ...p } }, timer })
    return true
  }

  function broadcast(msg: Msg, exclude?: string) {
    if (!hub) return
    const raw = JSON.stringify(msg)
    for (const [id, client] of hub.clients) {
      if (id === exclude) continue
      try {
        client.ws.send(raw)
      } catch {
        // will be cleaned up on close
      }
    }
    // In relay mode, send to relay (which broadcasts to remote clients)
    if (hub.relayWs && hub.relayWs.readyState === WebSocket.OPEN) {
      try {
        hub.relayWs.send(raw)
      } catch {}
    }
  }

  function broadcastTo(id: string, msg: Msg) {
    if (!hub) return
    const raw = JSON.stringify(msg)
    const client = hub.clients.get(id)
    if (client) {
      try {
        client.ws.send(raw)
      } catch {}
      return
    }
    // Relay targeted send
    if (hub.relayWs && hub.relayWs.readyState === WebSocket.OPEN) {
      try {
        hub.relayWs.send(JSON.stringify({ ...msg, __to: id }))
      } catch {}
    }
  }

  function participants(): Participant[] {
    if (!hub) return []
    return [...hub.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      joined: c.joined,
      session: c.session ?? null,
      role: c.role,
    }))
  }

  export function active(): Hub | null {
    return hub
  }

  // Start a local WebSocket server (LAN mode)
  async function startLocal(opts: { port?: number; hostname?: string; secret: string }): Promise<{ port: number }> {
    const { secret } = opts
    const hostname = opts.hostname ?? "0.0.0.0"

    const server = Bun.serve<{ code: string; name: string }>({
      hostname,
      port: opts.port ?? 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === "/health") return new Response("ok")
        const ok = srv.upgrade(req, {
          data: {
            code: url.searchParams.get("code") ?? "",
            name: url.searchParams.get("name") ?? "",
          },
        })
        if (ok) return undefined
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: {
        open(ws) {
          if (!codeValid(secret, ws.data.code)) {
            ws.send(JSON.stringify({ type: "kicked", reason: "invalid or expired code" }))
            ws.close(4001, "invalid code")
            return
          }
          const id = crypto.randomBytes(4).toString("hex")
          const raw = (ws.data.name || "")
            .trim()
            .replace(/[^a-zA-Z0-9_\- ]/g, "")
            .slice(0, 32)
          const name = raw || `user-${id.slice(0, 4)}`
          ;(ws as any).__id = id
          ;(ws as any).__name = name
          const role = hub!.roles.get(name) ?? "viewer"
          hub!.clients.set(id, { id, name, joined: Date.now(), ws: ws as unknown as WebSocket, role })
          ws.send(JSON.stringify({ type: "hello", id, name, code: secret }))
          ws.send(JSON.stringify(snapshot()))
          broadcast({ type: "joined", id, name })
          broadcast({ type: "participants", list: participants() })
          log.info("participant joined", { id, name })
        },
        message(ws, msg) {
          if (typeof msg !== "string") return
          const id = (ws as any).__id as string
          const name = (ws as any).__name as string
          try {
            const parsed = JSON.parse(msg) as Msg
            const c = hub!.clients.get(id)
            if (c && c.role !== "editor" && !VIEWER_ALLOWED.has(parsed.type)) {
              log.info("dropped message from viewer", { id, type: parsed.type })
              return
            }
            if (parsed.type === "chat") {
              const relay: Msg = { type: "chat", from: id, name, text: (parsed as any).text ?? "", ts: Date.now() }
              broadcast(relay)
              return
            }
            if (parsed.type === "presence") {
              if (c) c.session = ((parsed as any).session as string | null) ?? null
              broadcast({ type: "participants", list: participants() })
              return
            }
            if (SIGNAL.has(parsed.type)) {
              const to = (parsed as any).__to as string | undefined
              const out = { ...(parsed as any), from: id } as unknown as Msg
              delete (out as any).__to
              if (to) {
                broadcastTo(to, out)
              } else {
                broadcast(out, id)
              }
              return
            }
            broadcast(parsed, id)
          } catch {}
        },
        close(ws) {
          const id = (ws as any).__id as string
          const name = (ws as any).__name as string
          if (id) {
            hub!.clients.delete(id)
            broadcast({ type: "left", id, name })
            broadcast({ type: "participants", list: participants() })
            log.info("participant left", { id, name })
          }
        },
      },
    })

    hub!.server = server
    return { port: server.port ?? 0 }
  }

  // Connect to relay as host (with reconnect support)
  const MAX_RETRIES = 5
  const RETRY_BASE = 1000 // 1s, doubles each attempt

  function connectRelay(relayUrl: string, code: string) {
    if (!hub || hub.stopped) return
    const { key, token } = hub

    let params = `role=host&code=${code}&key=${encodeURIComponent(key)}`
    if (token) params += `&token=${encodeURIComponent(token)}`
    // If admin token is available, pass via Authorization header is not
    // possible with browser WebSocket API — relay checks query params for host key only.
    // Admin auth uses HTTP Authorization header which WebSocket doesn't support natively.
    // Relay admin gating is for the HTTP upgrade, which Bun's client WS handles at fetch level.
    const ws = new WebSocket(`${relayUrl}/?${params}`)
    let retries = 0

    ws.onopen = () => {
      retries = 0
      hub!.reconnecting = false
      log.info("relay host connected", { relayUrl, code: code.slice(0, 6) })
    }

    ws.onmessage = (evt) => {
      if (typeof evt.data !== "string") return
      try {
        const msg = JSON.parse(evt.data) as Record<string, unknown>

        if (msg.type === "registered") {
          const resumed = msg.resumed as boolean
          const clients = (msg.clients ?? []) as Array<{ id: string; name: string }>
          if (resumed) {
            // Re-populate virtual clients from relay's list
            for (const c of clients) {
              if (!hub!.clients.has(c.id)) {
                hub!.clients.set(c.id, {
                  id: c.id,
                  name: c.name,
                  joined: Date.now(),
                  role: hub!.roles.get(c.name) ?? "viewer",
                  ws: {
                    send: (d: string) => ws.send(JSON.stringify({ ...JSON.parse(d), __to: c.id })),
                    close: () => {},
                  } as any,
                })
              }
            }
            broadcast({ type: "participants", list: participants() })
            log.info("session resumed with relay", { code: code.slice(0, 6), clients: clients.length })
          } else {
            log.info("session registered with relay", { code: code.slice(0, 6) })
          }
          return
        }

        if (msg.type === "relay_client_joined") {
          const id = msg.id as string
          const name = msg.name as string
          // Add a virtual "relay" client
          hub!.clients.set(id, {
            id,
            name,
            joined: Date.now(),
            role: hub!.roles.get(name) ?? "viewer",
            ws: {
              send: (d: string) => ws.send(JSON.stringify({ ...JSON.parse(d), __to: id })),
              close: () => {},
            } as any,
          })
          broadcast({ type: "joined", id, name })
          broadcast({ type: "participants", list: participants() })
          // Send hello directly to new client, then snapshot of recent events
          ws.send(JSON.stringify({ type: "hello", id, name, code, __to: id }))
          ws.send(JSON.stringify({ ...snapshot(), __to: id }))
          log.info("relay participant joined", { id, name })
          return
        }

        if (msg.type === "relay_client_left") {
          const id = msg.id as string
          const name = (msg.name ?? hub?.clients.get(id)?.name ?? "unknown") as string
          hub!.clients.delete(id)
          broadcast({ type: "left", id, name })
          broadcast({ type: "participants", list: participants() })
          log.info("relay participant left", { id })
          return
        }

        if (msg.type === "error") {
          log.info("relay error", { reason: msg.reason })
          return
        }

        // Messages from clients (tagged with __from by relay)
        const from = msg.__from as string | undefined
        const fromName = msg.__name as string | undefined
        if (!from) return
        const { __from: _f, __name: _n, ...payload } = msg
        const parsed = payload as Msg
        const fromClient = hub!.clients.get(from)
        if (fromClient && fromClient.role !== "editor" && !VIEWER_ALLOWED.has(parsed.type)) {
          log.info("dropped relay message from viewer", { from, type: parsed.type })
          return
        }

        if (parsed.type === "chat") {
          const relay: Msg = {
            type: "chat",
            from,
            name: fromName ?? from,
            text: (parsed as any).text ?? "",
            ts: Date.now(),
          }
          broadcast(relay)
        } else if (parsed.type === "presence") {
          const c = hub!.clients.get(from)
          if (c) c.session = (parsed as any).session ?? null
          broadcast({ type: "participants", list: participants() })
        } else if (SIGNAL.has(parsed.type)) {
          const to = (parsed as any).__to as string | undefined
          const out = { ...(parsed as any), from } as unknown as Msg
          delete (out as any).__to
          if (to) broadcastTo(to, out)
          else broadcast(out, from)
        }
      } catch {}
    }

    ws.onerror = () => {
      log.info("relay host ws error")
    }

    ws.onclose = (evt) => {
      log.info("relay host ws closed", { code: evt.code, reason: evt.reason })
      if (hub) hub.relayWs = null
      if (!hub || hub.stopped) return

      // Reconnect with exponential backoff
      if (retries < MAX_RETRIES) {
        retries++
        hub.reconnecting = true
        const delay = RETRY_BASE * Math.pow(2, retries - 1)
        log.info("relay reconnecting", { attempt: retries, delay })
        setTimeout(() => connectRelay(relayUrl, code), delay)
      } else {
        log.info("relay reconnect failed after max retries")
        hub.reconnecting = false
      }
    }

    hub!.relayWs = ws
  }

  export async function start(opts: {
    port?: number
    hostname?: string
    relay?: string
    token?: string
  }): Promise<{ code: string; port: number; hostname: string; relay: string | null; locked: boolean }> {
    if (hub) throw new Error("Live share session already active")

    const secret = makeCode()
    const relay = opts.relay ?? process.env.CRIMECODE_RELAY_URL ?? null
    const hostname = opts.hostname ?? "0.0.0.0"
    const unsubs: (() => void)[] = []
    const key = b62(24) // 24 char base62 key for relay auth/resume
    const token = opts.token ?? ""

    hub = {
      code: secret,
      port: 0,
      hostname,
      relay,
      token,
      key,
      clients: new Map(),
      server: null,
      relayWs: null,
      unsubs,
      reconnecting: false,
      stopped: false,
      history: [],
      roles: new Map(),
    }

    let port = 0
    if (!relay) {
      const result = await startLocal({ port: opts.port, hostname, secret })
      port = result.port
      hub.port = port
    } else {
      connectRelay(relay, secret)
    }

    // Forward relevant Bus events to participants and record replay history.
    // High-frequency PartDelta events are coalesced over a short window.
    // Only broadcast events that affect team collaboration (not internal details).
    const BROADCAST_EVENTS = new Set([
      "message.updated",
      "message.part.delta",
      "todo.updated",
      "cursor.moved",
      "presence.updated",
    ])
    unsubs.push(
      Bus.subscribeAll((payload) => {
        record(payload)
        if (coalesce(payload)) return
        // Only broadcast events relevant to live collaboration
        if (BROADCAST_EVENTS.has(payload?.type)) {
          broadcast({ type: "event", payload })
        }
      }),
    )

    // Forward file-watcher events WITH file content
    unsubs.push(
      Bus.subscribe(FileWatcher.Event.Updated, (payload) => {
        const file = payload.properties.file
        const event = payload.properties.event
        broadcast({ type: "file", file, event })
        fs.readFile(file, "utf-8")
          .then((content) => broadcast({ type: "file_content", file, content, event }))
          .catch(() => {})
      }),
    )

    log.info("live share started", { code: secret.slice(0, 6), port, hostname, relay, locked: !!token })
    return { code: secret, port, hostname, relay, locked: !!token }
  }

  export function kick(id: string, reason?: string) {
    if (!hub) throw new Error("No active live share session")
    const client = hub.clients.get(id)
    if (!client) throw new Error(`Participant ${id} not found`)

    // For relay clients, send kick through relay
    if (hub.relayWs && hub.relayWs.readyState === WebSocket.OPEN) {
      hub.relayWs.send(JSON.stringify({ type: "kick", __to: id, reason: reason ?? "kicked by host" }))
    }

    try {
      client.ws.send(JSON.stringify({ type: "kicked", reason: reason ?? "kicked by host" }))
    } catch {}
    try {
      client.ws.close(4002, "kicked")
    } catch {}
    hub.clients.delete(id)
    broadcast({ type: "left", id, name: client.name })
    broadcast({ type: "participants", list: participants() })
    log.info("participant kicked", { id, name: client.name, reason })
  }

  export function stop() {
    if (!hub) throw new Error("No active live share session")
    hub.stopped = true
    flushAllDeltas()
    broadcast({ type: "stopped" })
    for (const client of hub.clients.values()) {
      try {
        client.ws.close(1000, "session ended")
      } catch {}
    }
    for (const unsub of hub.unsubs) {
      try {
        unsub()
      } catch {}
    }
    hub.relayWs?.close(1000, "session ended")
    hub.server?.stop()
    log.info("live share stopped", { code: hub.code.slice(0, 6) })
    hub = null
  }

  export function listParticipants(): Participant[] {
    return participants()
  }

  export function setRole(id: string, role: Role) {
    if (!hub) throw new Error("No active live share session")
    const c = hub.clients.get(id)
    if (!c) throw new Error(`Participant ${id} not found`)
    c.role = role
    // Remember this role by name so reconnects under the same name keep it.
    hub.roles.set(c.name, role)
    broadcast({ type: "participants", list: participants() })
    log.info("participant role updated", { id, role })
  }

  // --- Client (Participant) side ---

  interface Connection {
    ws: WebSocket
    id: string
    name: string
    code: string
    relay: boolean
    handlers: Map<string, Set<(msg: Msg) => void>>
  }

  let conn: Connection | null = null

  export function connection(): Connection | null {
    return conn
  }

  export function join(opts: {
    host?: string
    port?: number
    relay?: string
    code: string
    name?: string
    token?: string
    onMessage?: (msg: Msg) => void
    onClose?: (reason: string) => void
  }): Promise<{ id: string; name: string }> {
    return new Promise((resolve, reject) => {
      if (conn) {
        reject(new Error("Already connected to a live share session"))
        return
      }

      const relay = opts.relay ?? process.env.CRIMECODE_RELAY_URL ?? null
      const nameParam = opts.name ? `&name=${encodeURIComponent(opts.name)}` : ""
      const tokenParam = opts.token ? `&token=${encodeURIComponent(opts.token)}` : ""
      const isRelay = !!relay

      let url: string
      if (relay) {
        url = `${relay}/?role=client&code=${opts.code}${nameParam}${tokenParam}`
      } else {
        if (!opts.host || !opts.port) {
          reject(new Error("host and port required for LAN mode"))
          return
        }
        url = `ws://${opts.host}:${opts.port}/?code=${opts.code}${nameParam}`
      }

      const ws = new WebSocket(url)
      const handlers = new Map<string, Set<(msg: Msg) => void>>()

      ws.onopen = () => {
        log.info("connected to live share", { url })
      }

      ws.onmessage = (evt) => {
        if (typeof evt.data !== "string") return
        try {
          const raw = JSON.parse(evt.data) as Record<string, unknown>

          // Relay mode: relay_connected is the "hello" equivalent
          if (raw.type === "relay_connected") {
            const id = raw.id as string
            const name = raw.name as string
            const code = raw.code as string
            conn = { ws, id, name, code, relay: true, handlers }
            resolve({ id, name })
            opts.onMessage?.({ type: "hello", id, name, code })
            return
          }

          const msg = raw as unknown as Msg

          if (msg.type === "hello") {
            conn = { ws, id: msg.id, name: msg.name, code: msg.code, relay: isRelay, handlers }
            resolve({ id: msg.id, name: msg.name })
          }
          if (msg.type === "kicked") {
            log.info("kicked from live share", { reason: (msg as any).reason })
            opts.onClose?.((msg as any).reason ?? "kicked")
            cleanup()
          }
          if (msg.type === "stopped") {
            log.info("live share session ended by host")
            opts.onClose?.("session ended by host")
            cleanup()
          }
          if (raw.type === "error") {
            reject(new Error((raw.reason as string) ?? "relay error"))
            cleanup()
            return
          }

          opts.onMessage?.(msg)
          const set = handlers.get(msg.type)
          if (set) for (const fn of set) fn(msg)
        } catch {}
      }

      ws.onerror = () => {
        reject(new Error("Connection failed"))
        cleanup()
      }

      ws.onclose = (evt) => {
        log.info("live share connection closed", { code: evt.code, reason: evt.reason })
        opts.onClose?.(evt.reason || "connection closed")
        cleanup()
      }

      function cleanup() {
        if (conn?.ws === ws) conn = null
      }
    })
  }

  export function leave() {
    if (!conn) throw new Error("Not connected to a live share session")
    conn.ws.close(1000, "leaving")
    conn = null
  }

  export function send(msg: Msg) {
    if (!conn) throw new Error("Not connected to a live share session")
    conn.ws.send(JSON.stringify(msg))
  }

  export function chat(text: string) {
    if (!conn) throw new Error("Not connected to a live share session")
    conn.ws.send(JSON.stringify({ type: "chat", text }))
  }

  export function on(type: string, handler: (msg: Msg) => void): () => void {
    if (!conn) throw new Error("Not connected to a live share session")
    let set = conn.handlers.get(type)
    if (!set) {
      set = new Set()
      conn.handlers.set(type, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }
}
