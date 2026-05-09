/**
 * Community Chat — Phase 2
 *
 * Chat globale live tra tutti gli utenti registrati con username settato.
 * Architettura SSE-based:
 *   - Client invia messaggio via POST /community/chat/post
 *   - Server salva in `community_message` e fa broadcast a tutti gli SSE
 *     subscriber via in-memory queue
 *   - Client si abbona via GET /community/chat/stream (EventSource)
 *
 * Anti-abuse:
 *   - Solo utenti con username settato possono postare (community_user.username NOT NULL)
 *   - Rate limit: 10 messaggi/min/user
 *   - Max 500 char per messaggio (whitespace-trimmed)
 *   - Slow mode: 2 sec tra due messaggi consecutivi dello stesso user
 *   - Blacklist parole: sostituisce con asterischi (no full block — UX più morbido)
 *   - Soft delete: messaggi cancellati restano in DB ma non vengono restituiti
 *
 * Persistence:
 *   - Tutti i messaggi salvati nel licenseDb (SQLite, già WAL mode)
 *   - GET /community/chat/recent ritorna gli ultimi 100 messaggi non-cancellati
 *
 * Phase 3 (DM 1:1 + rep system) atterra in community-dm.ts e community-rep.ts.
 */
import type { Context, Hono } from "hono"
import type { Database } from "bun:sqlite"
import { streamSSE } from "hono/streaming"
import { userAuth } from "../middleware/user-auth.ts"

// ─── Schema ────────────────────────────────────────────────────────────

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  username    TEXT NOT NULL,
  body        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  deleted_at  INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS community_message_ts_idx ON community_message(ts DESC);
CREATE INDEX IF NOT EXISTS community_message_customer_idx ON community_message(customer_id);
`

export function ensureChatSchema(db: Database) {
  db.exec(CHAT_SCHEMA)
}

// ─── Validation + anti-abuse ───────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 500
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const SLOW_MODE_MS = 2_000

// Blacklist conservativa (italiano + inglese basic). Sostituisce con asterischi
// invece di bloccare il messaggio — UX più morbido per gli edge case innocenti.
const BLACKLIST_RE = /\b(merda|cazzo|stronzo|coglione|fuck|shit|asshole)\b/gi

function sanitize(body: string): string {
  return body.replace(BLACKLIST_RE, (m) => "*".repeat(m.length))
}

function validateMessage(body: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof body !== "string") return { ok: false, error: "body deve essere stringa" }
  const trimmed = body.trim()
  if (trimmed.length === 0) return { ok: false, error: "messaggio vuoto" }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `max ${MAX_MESSAGE_LENGTH} caratteri (hai ${trimmed.length})` }
  }
  return { ok: true, body: sanitize(trimmed) }
}

// ─── In-memory broadcast queue ──────────────────────────────────────────

type ChatMessage = {
  id: number
  username: string
  body: string
  ts: number
  /** Avatar seed (dicebear) — joined from community_user at read time. */
  avatar_seed?: string | null
  /** Custom uploaded avatar URL — overrides avatar_seed if present. */
  avatar_url?: string | null
}

type Subscriber = {
  send: (msg: ChatMessage) => void
}

const subscribers = new Set<Subscriber>()

function broadcast(msg: ChatMessage) {
  for (const s of subscribers) {
    try {
      s.send(msg)
    } catch {
      // Client probabilmente disconnesso — verrà rimosso quando l'SSE
      // stream throws su prossima write. Niente da fare qui.
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────

export type CommunityChatDeps = {
  licenseDb: Database
}

export function mountCommunityChatRoutes(app: Hono, deps: CommunityChatDeps) {
  ensureChatSchema(deps.licenseDb)
  const auth = userAuth({ licenseDb: deps.licenseDb })
  const db = deps.licenseDb

  // ── GET /community/chat/recent — public ──────────────────────────────
  // Ritorna ultimi N messaggi non-cancellati per warm-up del client al
  // primo connect. Default 100, max 200.
  app.get("/community/chat/recent", (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 200)
    // LEFT JOIN community_user su username per portare avatar_seed +
    // avatar_url, così il frontend può mostrare l'avatar custom o quello
    // dicebear senza un round-trip per ogni utente. Senza questo join,
    // tutti i messaggi mostrano un avatar generato dall'username (sbagliato:
    // l'avatar_seed è una stringa random salvata separatamente al signup).
    const rows = db
      .query<
        {
          id: number
          username: string
          body: string
          ts: number
          avatar_seed: string | null
          avatar_url: string | null
        },
        [number]
      >(
        `SELECT m.id, m.username, m.body, m.ts,
                u.avatar_seed AS avatar_seed,
                u.avatar_url  AS avatar_url
         FROM community_message m
         LEFT JOIN community_user u ON u.username = m.username
         WHERE m.deleted_at IS NULL
         ORDER BY m.ts DESC
         LIMIT ?`,
      )
      .all(limit)
    // Reverse: vogliamo ordine cronologico ascendente nel client (oldest first)
    return c.json({ messages: rows.reverse() })
  })

  // ── POST /community/chat/post — auth required ────────────────────────
  // Invia un messaggio. Validation + rate limit + slow mode.
  app.post("/community/chat/post", auth, async (c) => {
    const customer = c.var.customer
    const body = await c.req.json<{ body?: unknown }>().catch(() => ({}))
    const validation = validateMessage(body?.body)
    if (!validation.ok) return c.json({ error: validation.error }, 400)

    // Lookup username + avatar dell'utente. Carichiamo anche avatar_seed/url
    // così il broadcast include l'avatar e tutti gli altri client lo vedono
    // senza dover fare un GET separato.
    const profile = db
      .query<{ username: string | null; avatar_seed: string | null; avatar_url: string | null }, [string]>(
        "SELECT username, avatar_seed, avatar_url FROM community_user WHERE customer_id = ?",
      )
      .get(customer.id)
    if (!profile?.username) {
      return c.json({ error: "Imposta prima un username pubblico in /community" }, 403)
    }

    const now = Date.now()

    // Slow mode: 2s tra messaggi
    const lastMsg = db
      .query<{ ts: number }, [string]>(
        "SELECT ts FROM community_message WHERE customer_id = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(customer.id)
    if (lastMsg && now - lastMsg.ts < SLOW_MODE_MS) {
      const wait = Math.ceil((SLOW_MODE_MS - (now - lastMsg.ts)) / 1000)
      return c.json({ error: `slow mode: aspetta ${wait}s prima di rinviare` }, 429)
    }

    // Rate limit: 10 messaggi/min
    const windowStart = now - RATE_LIMIT_WINDOW_MS
    const recentCount = (db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM community_message WHERE customer_id = ? AND ts >= ?",
      )
      .get(customer.id, windowStart)?.n ?? 0)
    if (recentCount >= RATE_LIMIT_MAX) {
      return c.json({ error: `rate limit: max ${RATE_LIMIT_MAX} messaggi/min` }, 429)
    }

    // Insert
    const result = db
      .prepare(
        "INSERT INTO community_message (customer_id, username, body, ts) VALUES (?, ?, ?, ?)",
      )
      .run(customer.id, profile.username, validation.body, now)

    const msg: ChatMessage = {
      id: Number(result.lastInsertRowid),
      username: profile.username,
      body: validation.body,
      ts: now,
      avatar_seed: profile.avatar_seed,
      avatar_url: profile.avatar_url,
    }
    broadcast(msg)

    // Touch last_active community_user
    db.prepare("UPDATE community_user SET last_active = ? WHERE customer_id = ?").run(now, customer.id)

    return c.json({ ok: true, message: msg })
  })

  // ── DELETE /community/chat/msg/:id — auth required ───────────────────
  // Soft-delete. Solo l'autore può cancellare. (Phase 3: admin override.)
  app.delete("/community/chat/msg/:id", auth, (c) => {
    const customer = c.var.customer
    const id = parseInt(c.req.param("id"), 10)
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "id non valido" }, 400)

    const row = db
      .query<{ customer_id: string; deleted_at: number | null }, [number]>(
        "SELECT customer_id, deleted_at FROM community_message WHERE id = ?",
      )
      .get(id)
    if (!row) return c.json({ error: "messaggio non trovato" }, 404)
    if (row.customer_id !== customer.id) {
      return c.json({ error: "puoi cancellare solo i tuoi messaggi" }, 403)
    }
    if (row.deleted_at) return c.json({ ok: true, alreadyDeleted: true })

    db.prepare("UPDATE community_message SET deleted_at = ? WHERE id = ?").run(Date.now(), id)
    // Broadcast una "delete" event per aggiornare i client live
    broadcast({ id, username: "_deleted_", body: "[messaggio cancellato]", ts: Date.now() } as ChatMessage)
    return c.json({ ok: true })
  })

  // ── GET /community/chat/stream — SSE feed (public) ───────────────────
  // Si registra come subscriber e riceve nuovi messaggi in tempo reale.
  // Fa anche heartbeat ogni 25s per tenere la connessione viva attraverso
  // proxy/load balancer che killano connessioni idle a 30s.
  app.get("/community/chat/stream", (c: Context) => {
    // BUG-FIX (EventSource error readyState=0 da Electron renderer):
    // Hono cors middleware non riesce ad iniettare ACAO sulle response SSE
    // perché lo stream è già committed quando il middleware prova ad
    // aggiungere gli headers. Settiamoli manualmente prima di streamSSE.
    c.header("Access-Control-Allow-Origin", "*")
    c.header("Cache-Control", "no-cache, no-transform")
    c.header("X-Accel-Buffering", "no") // disabilita buffering proxy nginx/caddy
    return streamSSE(c, async (stream) => {
      const sub: Subscriber = {
        send: (msg) => {
          // Fire-and-forget: se la connessione è morta lo stream throws
          // sull'await e finiamo nel finally.
          void stream.writeSSE({
            event: "message",
            data: JSON.stringify(msg),
          })
        },
      }
      subscribers.add(sub)

      // Initial flush: invia un "ready" event subito così il client conferma
      // open immediatamente (altrimenti l'EventSource resta in CONNECTING fino
      // al primo heartbeat a 25s — confonde la UI "Riconnessione...").
      void stream.writeSSE({ event: "ready", data: String(Date.now()) }).catch(() => {})

      // Heartbeat
      const hb = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {})
      }, 25_000)

      try {
        // Mantieni la stream aperta finché il client non si disconnette
        // (stream.aborted o errore di scrittura).
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve())
        })
      } finally {
        clearInterval(hb)
        subscribers.delete(sub)
      }
    })
  })

  // ── GET /community/chat/stats — public ──────────────────────────────
  // Conteggio rapido per UI (numero messaggi totali, utenti unici recenti)
  app.get("/community/chat/stats", (c) => {
    const day = Date.now() - 24 * 60 * 60 * 1000
    const total = (db
      .query<{ n: number }>("SELECT COUNT(*) AS n FROM community_message WHERE deleted_at IS NULL")
      .get()?.n ?? 0)
    const today = (db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM community_message WHERE deleted_at IS NULL AND ts >= ?",
      )
      .get(day)?.n ?? 0)
    const activeUsers = (db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(DISTINCT customer_id) AS n FROM community_message WHERE ts >= ?",
      )
      .get(day)?.n ?? 0)
    return c.json({
      total_messages: total,
      messages_24h: today,
      active_users_24h: activeUsers,
      live_subscribers: subscribers.size,
    })
  })
}
