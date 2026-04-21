import type { ServerWebSocket } from "bun"

interface WsData {
  role?: "host" | "client"
  code?: string
  name?: string
  key?: string
  token?: string
  clientId?: string
  requestUrl?: string
  lastPong?: number
}

interface Invite {
  url: string
  code: string
  hostKey: string
  token?: string
  expires: number
}

interface ClientInfo {
  ws: ServerWebSocket<WsData>
  id: string
  name: string
  code: string
}

export interface RelayOptions {
  port?: number
  pingInterval?: number
  pongTimeout?: number
  hostResumeGrace?: number
  inviteTtl?: number
  silent?: boolean
}

export function startRelay(opts: RelayOptions = {}) {
  const port = opts.port ?? Number(process.env.RELAY_PORT) ?? 3747
  const PING_INTERVAL = opts.pingInterval ?? 20_000
  const PONG_TIMEOUT = opts.pongTimeout ?? 45_000
  const HOST_RESUME_GRACE = opts.hostResumeGrace ?? 30_000
  const INVITE_TTL = opts.inviteTtl ?? 30 * 60 * 1000
  const log = (...args: unknown[]) => {
    if (!opts.silent) console.log(...args)
  }

  const hosts = new Map<string, ServerWebSocket<WsData>>()
  const clients = new Map<string, ClientInfo>()
  const invites = new Map<string, Invite>()
  const clientsByHost = new Map<string, Set<string>>()
  const hostResume = new Map<string, ReturnType<typeof setTimeout>>()

  const id = (len = 8) =>
    Array.from({ length: len }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charAt(Math.floor(Math.random() * 36)),
    ).join("")

  const send = (ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) => {
    try {
      return ws.send(JSON.stringify(msg)) > 0
    } catch {
      return false
    }
  }

  const toHost = (code: string, msg: Record<string, unknown>) => {
    const host = hosts.get(code)
    if (host) send(host, msg)
  }

  const clientList = (code: string) => {
    const ids = clientsByHost.get(code) ?? new Set<string>()
    return [...ids].flatMap((cid) => {
      const c = clients.get(cid)
      return c ? [{ id: c.id, name: c.name }] : []
    })
  }

  const dropClient = (cid: string, reason: string) => {
    const c = clients.get(cid)
    if (!c) return
    clients.delete(cid)
    clientsByHost.get(c.code)?.delete(cid)
    toHost(c.code, { type: "relay_client_left", id: c.id, name: c.name, reason })
  }

  const server = Bun.serve<WsData>({
    port,
    async fetch(req, srv) {
      const upgrade = req.headers.get("upgrade")
      if (upgrade?.toLowerCase() === "websocket") {
        const url = new URL(req.url)
        const role = url.searchParams.get("role")
        const code = url.searchParams.get("code")?.toUpperCase()
        if (role && code) {
          const ok = srv.upgrade(req, { data: { requestUrl: req.url } })
          if (ok) return
        }
      }

      const url = new URL(req.url)
      const path = url.pathname

      if (path === "/health") {
        return Response.json({ status: "ok", hosts: hosts.size, clients: clients.size, invites: invites.size })
      }

      if (path.startsWith("/invite/")) {
        const code = path.slice("/invite/".length).toUpperCase()
        const invite = invites.get(code)
        if (!invite || Date.now() > invite.expires)
          return Response.json({ error: "Invite not found or expired" }, { status: 404 })
        return Response.json({ url: invite.url, token: invite.token })
      }

      if (path === "/invite" && req.method === "POST") {
        try {
          const body = (await req.json()) as { url: string; token?: string }
          if (!body?.url) return Response.json({ error: "Missing url" }, { status: 400 })
          const code = id(8)
          const hostKey = id(24)
          invites.set(code, { url: body.url, code, hostKey, token: body.token, expires: Date.now() + INVITE_TTL })
          return Response.json({ code, hostKey, expires: Date.now() + INVITE_TTL })
        } catch {
          return Response.json({ error: "Invalid request body" }, { status: 400 })
        }
      }

      if (path === "/invite" && req.method === "GET") {
        return Response.json(
          [...invites.values()].map((i) => ({
            code: i.code,
            url: i.url,
            expires: i.expires,
            remaining: i.expires - Date.now(),
          })),
        )
      }

      return new Response("Not found", { status: 404 })
    },
    websocket: {
      idleTimeout: 120,
      sendPings: false,
      open(ws) {
        const url = new URL(ws.data.requestUrl ?? "", "http://localhost")
        const p = url.searchParams
        const role = p.get("role") as "host" | "client" | null
        const code = p.get("code")?.toUpperCase()
        const name = p.get("name") ?? "anonymous"
        const key = p.get("key") ?? undefined
        const token = p.get("token") ?? undefined

        if (!role || !code) {
          ws.close(1008, "Missing role or code")
          return
        }
        ws.data = { ...ws.data, role, code, name, key, token, lastPong: Date.now() }

        if (role === "host") {
          const invite = invites.get(code)
          if (invite && key !== invite.hostKey) {
            ws.close(1008, "Invalid host key")
            return
          }
          const pending = hostResume.get(code)
          const resumed = !!pending
          if (pending) {
            clearTimeout(pending)
            hostResume.delete(code)
          }
          const prev = hosts.get(code)
          if (prev && prev !== ws) {
            try {
              prev.close(1000, "Replaced")
            } catch {}
          }
          hosts.set(code, ws)
          if (!clientsByHost.has(code)) clientsByHost.set(code, new Set())
          send(ws, { type: "registered", resumed, clients: clientList(code) })
          log(`[relay] Host ${resumed ? "resumed" : "connected"}: ${code}`)
          return
        }

        const invite = invites.get(code)
        if (!invite) {
          ws.close(1008, "Session not found")
          return
        }
        if (invite.token && invite.token !== token) {
          ws.close(1008, "Invalid token")
          return
        }

        const cid = id()
        ws.data.clientId = cid
        clients.set(cid, { ws, id: cid, name, code })
        const set = clientsByHost.get(code) ?? new Set<string>()
        set.add(cid)
        clientsByHost.set(code, set)
        toHost(code, { type: "relay_client_joined", id: cid, name })
        send(ws, { type: "hello", id: cid, name, code })
        log(`[relay] Client joined ${code} as ${name} (${cid})`)
      },
      message(ws, raw) {
        ws.data.lastPong = Date.now()
        let data: Record<string, unknown>
        try {
          data = JSON.parse(raw.toString()) as Record<string, unknown>
        } catch {
          return
        }
        if (data.type === "pong") return
        if (data.type === "ping") {
          send(ws, { type: "pong", ts: data.ts })
          return
        }
        const role = ws.data.role
        const code = ws.data.code
        if (!code) return
        if (role === "client") {
          const cid = ws.data.clientId
          if (!cid) return
          const c = clients.get(cid)
          if (!c) return
          toHost(code, { ...data, __from: cid, __name: c.name })
          return
        }
        if (role === "host") {
          const to = typeof data.__to === "string" ? data.__to : undefined
          const out = { ...data }
          delete (out as { __to?: unknown }).__to
          if (to) {
            const target = clients.get(to)
            if (target && target.code === code) send(target.ws, out)
            return
          }
          const ids = clientsByHost.get(code)
          if (!ids) return
          for (const cid of ids) {
            const target = clients.get(cid)
            if (target) send(target.ws, out)
          }
        }
      },
      pong(ws) {
        ws.data.lastPong = Date.now()
      },
      close(ws) {
        const { role, code, clientId } = ws.data
        if (role === "host" && code) {
          if (hosts.get(code) === ws) hosts.delete(code)
          const existing = hostResume.get(code)
          if (existing) clearTimeout(existing)
          const t = setTimeout(() => {
            hostResume.delete(code)
            const ids = clientsByHost.get(code)
            if (ids) {
              for (const cid of ids) {
                const c = clients.get(cid)
                if (c) {
                  send(c.ws, { type: "stopped" })
                  try {
                    c.ws.close(1000, "Host gone")
                  } catch {}
                  clients.delete(cid)
                }
              }
              clientsByHost.delete(code)
            }
            invites.delete(code)
            log(`[relay] Host grace expired: ${code}`)
          }, HOST_RESUME_GRACE)
          hostResume.set(code, t)
          const ids = clientsByHost.get(code)
          if (ids) {
            for (const cid of ids) {
              const c = clients.get(cid)
              if (c) send(c.ws, { type: "host_paused", grace: HOST_RESUME_GRACE })
            }
          }
          log(`[relay] Host disconnected (grace ${HOST_RESUME_GRACE}ms): ${code}`)
          return
        }
        if (role === "client" && clientId) {
          dropClient(clientId, "close")
          log(`[relay] Client disconnected: ${clientId}`)
        }
      },
    },
  })

  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const [code, ws] of hosts) {
      if (now - (ws.data.lastPong ?? now) > PONG_TIMEOUT) {
        log(`[relay] Host stale, closing: ${code}`)
        try {
          ws.close(1001, "Heartbeat timeout")
        } catch {}
        continue
      }
      try {
        ws.ping()
      } catch {}
    }
    for (const [cid, c] of clients) {
      if (now - (c.ws.data.lastPong ?? now) > PONG_TIMEOUT) {
        log(`[relay] Client stale, closing: ${cid}`)
        try {
          c.ws.close(1001, "Heartbeat timeout")
        } catch {}
        continue
      }
      try {
        c.ws.ping()
      } catch {}
    }
  }, PING_INTERVAL)

  return {
    port: server.port,
    stop: () => {
      clearInterval(heartbeat)
      server.stop(true)
    },
    stats: () => ({ hosts: hosts.size, clients: clients.size, invites: invites.size }),
  }
}
