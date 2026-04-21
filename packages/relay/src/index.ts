#!/usr/bin/env bun
/**
 * CrimeCode LiveShare Relay Server — Hardened
 *
 * Host connects as:   ws://<relay>/?role=host&code=<CODE>&key=<KEY>[&token=<TOKEN>]
 * Client connects as: ws://<relay>/?role=client&code=<CODE>&name=<NAME>[&token=<TOKEN>]
 *
 * Deploy on any VPS:  bun run start
 * Docker:             docker build -t crimecode-relay . && docker run -p 3747:3747 crimecode-relay
 */

// ── env ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3747)
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS ?? 20)
const TTL = Number(process.env.SESSION_TTL_MS ?? 60 * 60 * 1000) // 1h (was 24h)
const RESUME_MS = Number(process.env.HOST_RESUME_MS ?? 30_000) // 30s grace
const HTTP_LIMIT = Number(process.env.HTTP_RATE_LIMIT ?? 120) // req/min
const MSG_LIMIT = Number(process.env.MSG_RATE_LIMIT ?? 240) // msg/min/conn
const WINDOW = Number(process.env.RATE_WINDOW_MS ?? 60_000)
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD_BYTES ?? 256 * 1024) // 256KB
const IDLE_SEC = Number(process.env.WS_IDLE_TIMEOUT_SEC ?? 75)
const ADMIN = process.env.CRIMECODE_RELAY_ADMIN_TOKEN ?? process.env.RELAY_ADMIN_TOKEN ?? ""
const TRUST_PROXY = process.env.CRIMECODE_RELAY_TRUST_PROXY === "1"
const MAX_CHAT = 2000

// ── types ───────────────────────────────────────────────────────────────────

interface Data {
  role: "host" | "client"
  code: string
  id: string
  name: string
  ip: string
  key: string
  token: string
  hits: number
  reset: number
}

type WS = import("bun").ServerWebSocket<Data>

interface Peer {
  ws: WS
  name: string
  joined: number
  ip: string
}

interface Session {
  code: string
  host: WS | null
  key: string
  token: string
  clients: Map<string, Peer>
  created: number
  seen: number
  timer: ReturnType<typeof setTimeout>
  resume: ReturnType<typeof setTimeout> | null
}

// ── invite types ────────────────────────────────────────────────────────────

interface Invite {
  code: string
  url: string
  token: string
  host: string
  created: number
  expires: number
  timer: ReturnType<typeof setTimeout>
}

const INVITE_TTL = Number(process.env.INVITE_TTL_MS ?? 30 * 60 * 1000) // 30min
const INVITE_CODE_LEN = 8

function makeInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no ambiguous 0/O/1/I
  let code = ""
  const bytes = new Uint8Array(INVITE_CODE_LEN)
  crypto.getRandomValues(bytes)
  for (const b of bytes) code += chars[b % chars.length]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

// ── state ───────────────────────────────────────────────────────────────────

const invites = new Map<string, Invite>()
const sessions = new Map<string, Session>()
const ipHits = new Map<string, { hits: number; reset: number }>()

// ── logging ─────────────────────────────────────────────────────────────────

function tag(code: string) {
  return code.slice(0, 6)
}

function log(event: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), event, ...data }
  console.log(JSON.stringify(entry))
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sanitize(v: string, max = 32) {
  return v.replace(/[^a-zA-Z0-9_\- ]/g, "").slice(0, max)
}

function clientIp(req: Request, srv: { requestIP(r: Request): { address: string } | null }) {
  if (TRUST_PROXY) {
    const fwd = req.headers.get("x-forwarded-for")
    if (fwd) return fwd.split(",")[0]!.trim()
  }
  return srv.requestIP(req)?.address ?? "unknown"
}

function httpRateOk(ip: string): boolean {
  const now = Date.now()
  let bucket = ipHits.get(ip)
  if (!bucket || now >= bucket.reset) {
    bucket = { hits: 0, reset: now + WINDOW }
    ipHits.set(ip, bucket)
  }
  bucket.hits++
  return bucket.hits <= HTTP_LIMIT
}

function msgRateOk(ws: WS): boolean {
  const now = Date.now()
  if (now >= ws.data.reset) {
    ws.data.hits = 0
    ws.data.reset = now + WINDOW
  }
  ws.data.hits++
  return ws.data.hits <= MSG_LIMIT
}

function expire(code: string) {
  const s = sessions.get(code)
  if (!s) return
  clearTimeout(s.timer)
  if (s.resume) clearTimeout(s.resume)
  const msg = JSON.stringify({ type: "stopped", reason: "session expired" })
  try {
    s.host?.send(msg)
  } catch {}
  try {
    s.host?.close(1001, "expired")
  } catch {}
  for (const p of s.clients.values()) {
    try {
      p.ws.send(msg)
    } catch {}
    try {
      p.ws.close(1001, "expired")
    } catch {}
  }
  sessions.delete(code)
  log("session.expired", { room: tag(code) })
}

function schedule(s: Session) {
  clearTimeout(s.timer)
  s.timer = setTimeout(() => expire(s.code), TTL)
}

function peerList(s: Session) {
  return [...s.clients.entries()].map(([id, p]) => ({ id, name: p.name }))
}

function requireAdmin(req: Request): Response | null {
  if (!ADMIN) return null // no admin token configured — open access
  const header = req.headers.get("authorization") ?? ""
  const provided = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (provided === ADMIN) return null
  return new Response("unauthorized", { status: 401 })
}

// ── server ──────────────────────────────────────────────────────────────────

Bun.serve<Data>({
  port: PORT,

  async fetch(req, srv) {
    const ip = clientIp(req, srv as any)
    const url = new URL(req.url)

    // ── health ──
    if (url.pathname === "/health") return new Response("ok")

    // ── invite: create ──
    if (url.pathname === "/invite" && req.method === "POST") {
      if (!httpRateOk(ip)) return new Response("rate limited", { status: 429 })
      const denied = requireAdmin(req)
      if (denied) return denied
      try {
        const body = (await req.json()) as { url: string; token?: string; host?: string; ttl?: number }
        if (!body.url) return new Response("url required", { status: 400 })
        const code = makeInviteCode()
        const ttl = Math.min(body.ttl ?? INVITE_TTL, INVITE_TTL)
        const inv: Invite = {
          code,
          url: body.url,
          token: body.token ?? "",
          host: body.host ?? ip,
          created: Date.now(),
          expires: Date.now() + ttl,
          timer: setTimeout(() => {
            invites.delete(code)
            log("invite.expired", { code })
          }, ttl),
        }
        invites.set(code, inv)
        log("invite.created", { code, host: inv.host })
        return new Response(JSON.stringify({ code, expires: inv.expires }), {
          headers: { "content-type": "application/json" },
        })
      } catch {
        return new Response("invalid body", { status: 400 })
      }
    }

    // ── invite: resolve ──
    if (url.pathname.startsWith("/invite/") && req.method === "GET") {
      if (!httpRateOk(ip)) return new Response("rate limited", { status: 429 })
      const code = url.pathname.slice("/invite/".length).toUpperCase()
      const inv = invites.get(code)
      if (!inv || Date.now() > inv.expires) {
        return new Response(JSON.stringify({ error: "invite not found or expired" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      log("invite.resolved", { code, ip })
      return new Response(JSON.stringify({ url: inv.url, token: inv.token, host: inv.host, expires: inv.expires }), {
        headers: { "content-type": "application/json" },
      })
    }

    // ── invite: revoke ──
    if (url.pathname.startsWith("/invite/") && req.method === "DELETE") {
      if (!httpRateOk(ip)) return new Response("rate limited", { status: 429 })
      const denied = requireAdmin(req)
      if (denied) return denied
      const code = url.pathname.slice("/invite/".length).toUpperCase()
      const inv = invites.get(code)
      if (!inv) {
        return new Response(JSON.stringify({ error: "invite not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      clearTimeout(inv.timer)
      invites.delete(code)
      log("invite.revoked", { code })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })
    }

    // ── invite: list (admin only) ──
    if (url.pathname === "/invite" && req.method === "GET") {
      const denied = requireAdmin(req)
      if (denied) return denied
      const list = [...invites.values()].map((inv) => ({
        code: inv.code,
        url: inv.url,
        host: inv.host,
        created: inv.created,
        expires: inv.expires,
        remaining: Math.max(0, inv.expires - Date.now()),
      }))
      return new Response(JSON.stringify(list), {
        headers: { "content-type": "application/json" },
      })
    }

    // ── sessions list (admin only) ──
    if (url.pathname === "/sessions") {
      const denied = requireAdmin(req)
      if (denied) return denied
      const list = [...sessions.entries()].map(([code, s]) => ({
        room: tag(code),
        clients: s.clients.size,
        locked: !!s.token,
        age: Date.now() - s.created,
      }))
      return new Response(JSON.stringify(list), {
        headers: { "content-type": "application/json" },
      })
    }

    // ── rate limit ──
    if (!httpRateOk(ip)) return new Response("rate limited", { status: 429 })

    // ── ws upgrade ──
    const role = url.searchParams.get("role") as "host" | "client" | null
    const code = (url.searchParams.get("code") ?? "").toUpperCase()
    const name = sanitize(url.searchParams.get("name") ?? "") || `user-${crypto.randomUUID().slice(0, 4)}`
    const key = url.searchParams.get("key") ?? ""
    const token = url.searchParams.get("token") ?? ""

    if (!role || !code) return new Response("missing role or code", { status: 400 })
    if (role !== "host" && role !== "client") return new Response("invalid role", { status: 400 })

    // Host must provide a key >=16 chars
    if (role === "host" && key.length < 16) {
      return new Response("key required (>=16 chars)", { status: 400 })
    }

    // MANDATORY: host must provide a session join token (>=8 chars).
    // Prevents accidental open relays — every room is locked.
    if (role === "host" && token.length < 8) {
      return new Response("session token required (>=8 chars)", { status: 400 })
    }

    // Admin token gate for host registration (if configured)
    if (role === "host" && ADMIN) {
      const denied = requireAdmin(req)
      if (denied) return denied
    }

    // Client joining MUST supply the matching session token.
    // We accept the upgrade and close inside open() with a 4xxx code so the
    // browser onclose handler can distinguish auth failures (no retry).
    if (role === "client") {
      const s = sessions.get(code)
      if (!s) {
        // still accept upgrade so client sees structured close
      } else if (!s.token || s.token !== token) {
        // accept upgrade; will close with 4003 in open()
      }
    }

    const id = crypto.randomUUID().slice(0, 8)
    const ok = srv.upgrade(req, {
      data: { role, code, id, name, ip, key, token, hits: 0, reset: Date.now() + WINDOW },
    })
    if (ok) return undefined
    return new Response("upgrade failed", { status: 400 })
  },

  websocket: {
    maxPayloadLength: MAX_PAYLOAD,
    idleTimeout: IDLE_SEC,
    sendPings: true,
    backpressureLimit: 1024 * 1024, // 1MB
    closeOnBackpressureLimit: true,

    open(ws) {
      const { role, code, id, name, ip, key, token } = ws.data

      if (role === "host") {
        const existing = sessions.get(code)

        // ── host resume ──
        if (existing && existing.host === null && existing.key === key) {
          if (existing.resume) clearTimeout(existing.resume)
          existing.resume = null
          existing.host = ws
          existing.seen = Date.now()
          schedule(existing)
          ws.send(
            JSON.stringify({
              type: "registered",
              code,
              resumed: true,
              clients: peerList(existing),
            }),
          )
          // Notify clients host is back
          for (const p of existing.clients.values()) {
            try {
              p.ws.send(JSON.stringify({ type: "host_resumed" }))
            } catch {}
          }
          log("host.resumed", { room: tag(code), ip })
          return
        }

        // ── new session ──
        if (existing) {
          ws.send(JSON.stringify({ type: "error", reason: "session already exists" }))
          ws.close(4003, "duplicate session")
          return
        }

        const s: Session = {
          code,
          host: ws,
          key,
          token,
          clients: new Map(),
          created: Date.now(),
          seen: Date.now(),
          timer: setTimeout(() => {}, 0),
          resume: null,
        }
        schedule(s)
        sessions.set(code, s)
        ws.send(JSON.stringify({ type: "registered", code, resumed: false, clients: [] }))
        log("host.registered", { room: tag(code), ip, locked: !!token })
        return
      }

      // ── client join ──
      const s = sessions.get(code)
      if (!s) {
        ws.send(JSON.stringify({ type: "error", reason: "session not found" }))
        ws.close(4004, "session not found")
        return
      }
      if (!s.token || s.token !== token) {
        ws.send(JSON.stringify({ type: "error", reason: "invalid join token" }))
        ws.close(4003, "invalid join token")
        return
      }
      if (!s.host) {
        ws.send(JSON.stringify({ type: "error", reason: "host not connected" }))
        ws.close(4006, "host not connected")
        return
      }
      if (s.clients.size >= MAX_CLIENTS) {
        ws.send(JSON.stringify({ type: "error", reason: "session full" }))
        ws.close(4005, "session full")
        return
      }
      s.clients.set(id, { ws, name, joined: Date.now(), ip })
      try {
        s.host.send(JSON.stringify({ type: "relay_client_joined", id, name }))
      } catch {}
      ws.send(JSON.stringify({ type: "relay_connected", id, name, code }))
      log("client.joined", { room: tag(code), id, name, ip })
    },

    message(ws, raw) {
      if (!msgRateOk(ws)) return

      const { role, code, id } = ws.data
      const s = sessions.get(code)
      if (!s) return
      const str = typeof raw === "string" ? raw : new TextDecoder().decode(raw)

      // ── JSON-level ping/pong (works for both roles) ──
      // Cheap parse for ping detection without parsing every message twice.
      if (str.length < 64 && str.includes('"ping"')) {
        try {
          const p = JSON.parse(str) as { type?: string; ts?: number }
          if (p.type === "ping") {
            try {
              ws.send(JSON.stringify({ type: "pong", ts: p.ts ?? Date.now() }))
            } catch {}
            return
          }
        } catch {}
      }

      if (role === "host") {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(str)
        } catch {
          return
        }
        const to = parsed.__to as string | undefined

        // ── host-initiated kick ──
        if (parsed.type === "kick" && to) {
          const peer = s.clients.get(to)
          if (peer) {
            const reason = typeof parsed.reason === "string" ? parsed.reason : "kicked by host"
            try {
              peer.ws.send(JSON.stringify({ type: "kicked", reason }))
            } catch {}
            try {
              peer.ws.close(4002, "kicked")
            } catch {}
            s.clients.delete(to)
            log("client.kicked", { room: tag(code), id: to })
          }
          return
        }

        // ── targeted send ──
        if (to) {
          const target = s.clients.get(to)
          if (target) {
            const { __to: _, ...rest } = parsed
            try {
              target.ws.send(JSON.stringify(rest))
            } catch {}
          }
          return
        }

        // ── broadcast ──
        for (const p of s.clients.values()) {
          try {
            p.ws.send(str)
          } catch {}
        }
        return
      }

      // ── client → host (allowed types) ──
      if (!s.host) return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(str)
      } catch {
        return
      }

      const t = parsed.type as string | undefined
      const ALLOWED_FROM_CLIENT = new Set([
        "chat",
        "presence",
        "event",
        "screen.offer",
        "screen.answer",
        "screen.ice",
        "screen.stop",
        "cursor",
        "annotation",
      ])
      if (!t || !ALLOWED_FROM_CLIENT.has(t)) return

      if (t === "chat") {
        const text = typeof parsed.text === "string" ? parsed.text.slice(0, MAX_CHAT) : ""
        try {
          s.host.send(JSON.stringify({ type: "chat", text, __from: id, __name: ws.data.name }))
        } catch {}
        return
      }

      // forward signaling/presence verbatim with sender attribution
      try {
        s.host.send(JSON.stringify({ ...parsed, __from: id, __name: ws.data.name }))
      } catch {}
    },

    close(ws) {
      const { role, code, id, name } = ws.data
      const s = sessions.get(code)
      if (!s) return

      if (role === "host") {
        // Only act if this is the current host (not a stale resumed connection)
        if (s.host !== ws) return

        s.host = null
        log("host.lost", { room: tag(code) })

        // ── grace period for reconnect ──
        s.resume = setTimeout(() => {
          // Host didn't reconnect in time — tear down
          const bye = JSON.stringify({ type: "stopped", reason: "host disconnected" })
          for (const p of s.clients.values()) {
            try {
              p.ws.send(bye)
            } catch {}
            try {
              p.ws.close(1001, "host disconnected")
            } catch {}
          }
          clearTimeout(s.timer)
          sessions.delete(code)
          log("session.expired", { room: tag(code), reason: "host_timeout" })
        }, RESUME_MS)

        // Notify clients host is temporarily away
        for (const p of s.clients.values()) {
          try {
            p.ws.send(JSON.stringify({ type: "host_lost" }))
          } catch {}
        }
        return
      }

      // client left
      s.clients.delete(id)
      try {
        s.host?.send(JSON.stringify({ type: "relay_client_left", id, name }))
      } catch {}
      log("client.left", { room: tag(code), id })
    },
  },
})

log("ready", { port: PORT, admin: !!ADMIN, maxPayload: MAX_PAYLOAD, idle: IDLE_SEC, ttl: TTL, inviteTtl: INVITE_TTL })
