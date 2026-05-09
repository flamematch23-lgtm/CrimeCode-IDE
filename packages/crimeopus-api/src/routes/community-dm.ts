/**
 * Community DM — Phase 3
 *
 * DM 1:1 privati tra utenti registrati.
 *
 * Modello: conversation = par di customer_id (canonicalizzato A < B). Un solo
 * row in `community_dm_conversation`, N row in `community_dm_message`.
 *
 * Delivery: ogni utente loggato apre un proprio SSE personale su
 * /community/dm/stream (auth required). Quando arriva un nuovo messaggio,
 * lo broadcast solo ai 2 partecipanti via in-memory subscriber map.
 *
 * Anti-abuse:
 *   - Solo utenti con username settato possono inviare/ricevere
 *   - Rate limit: 30 DM/min/user totali
 *   - Slow mode: 1s tra messaggi consecutivi (più morbido di chat globale)
 *   - Max 2000 char (più di chat: DM è per discussioni più lunghe)
 *   - Block list: ogni utente può bloccare altri utenti (tabella separata)
 */
import type { Context, Hono } from "hono"
import type { Database } from "bun:sqlite"
import { streamSSE } from "hono/streaming"
import { userAuth } from "../middleware/user-auth.ts"

// ─── Schema ────────────────────────────────────────────────────────────

const DM_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_dm_conversation (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a          TEXT NOT NULL,
  user_b          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b),
  CHECK(user_a < user_b),
  FOREIGN KEY (user_a) REFERENCES customers(id),
  FOREIGN KEY (user_b) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS dm_conv_a_idx ON community_dm_conversation(user_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS dm_conv_b_idx ON community_dm_conversation(user_b, last_message_at DESC);

CREATE TABLE IF NOT EXISTS community_dm_message (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  read_at         INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES community_dm_conversation(id),
  FOREIGN KEY (sender_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS dm_msg_conv_ts_idx ON community_dm_message(conversation_id, ts);

CREATE TABLE IF NOT EXISTS community_dm_block (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES customers(id),
  FOREIGN KEY (blocked_id) REFERENCES customers(id)
);
`

export function ensureDmSchema(db: Database) {
  db.exec(DM_SCHEMA)
}

// ─── Validation ────────────────────────────────────────────────────────

const MAX_DM_LENGTH = 2000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30
const SLOW_MODE_MS = 1_000

function validateDm(body: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof body !== "string") return { ok: false, error: "body deve essere stringa" }
  const trimmed = body.trim()
  if (trimmed.length === 0) return { ok: false, error: "messaggio vuoto" }
  if (trimmed.length > MAX_DM_LENGTH) {
    return { ok: false, error: `max ${MAX_DM_LENGTH} caratteri (hai ${trimmed.length})` }
  }
  return { ok: true, body: trimmed }
}

// ─── Per-user broadcast ─────────────────────────────────────────────────

type DmEvent =
  | { type: "message"; conversation_id: number; message: { id: number; sender_username: string; body: string; ts: number } }
  | { type: "read"; conversation_id: number; up_to_message_id: number; reader_id: string }

type Subscriber = { userId: string; send: (ev: DmEvent) => void }

const subscribersByUser = new Map<string, Set<Subscriber>>()

function addSub(userId: string, sub: Subscriber) {
  let set = subscribersByUser.get(userId)
  if (!set) {
    set = new Set()
    subscribersByUser.set(userId, set)
  }
  set.add(sub)
}

function removeSub(userId: string, sub: Subscriber) {
  const set = subscribersByUser.get(userId)
  if (!set) return
  set.delete(sub)
  if (set.size === 0) subscribersByUser.delete(userId)
}

function dispatchToUser(userId: string, ev: DmEvent) {
  const set = subscribersByUser.get(userId)
  if (!set) return
  for (const s of set) {
    try {
      s.send(ev)
    } catch {
      /* connection dropped, will be cleaned up next write */
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function canonicalPair(a: string, b: string): { user_a: string; user_b: string } {
  return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a }
}

function getOrCreateConversation(db: Database, a: string, b: string): number {
  const { user_a, user_b } = canonicalPair(a, b)
  const existing = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM community_dm_conversation WHERE user_a = ? AND user_b = ?",
    )
    .get(user_a, user_b)
  if (existing) return existing.id
  const now = Date.now()
  const result = db
    .prepare(
      "INSERT INTO community_dm_conversation (user_a, user_b, created_at, last_message_at) VALUES (?, ?, ?, ?)",
    )
    .run(user_a, user_b, now, now)
  return Number(result.lastInsertRowid)
}

function isBlocked(db: Database, byUser: string, blockedUser: string): boolean {
  const r = db
    .query<{ blocker_id: string }, [string, string]>(
      "SELECT blocker_id FROM community_dm_block WHERE blocker_id = ? AND blocked_id = ?",
    )
    .get(byUser, blockedUser)
  return !!r
}

function getCustomerIdByUsername(db: Database, username: string): string | null {
  const r = db
    .query<{ customer_id: string }, [string]>(
      "SELECT customer_id FROM community_user WHERE LOWER(username) = LOWER(?)",
    )
    .get(username)
  return r?.customer_id ?? null
}

function getUsernameByCustomerId(db: Database, customerId: string): string | null {
  const r = db
    .query<{ username: string | null }, [string]>(
      "SELECT username FROM community_user WHERE customer_id = ?",
    )
    .get(customerId)
  return r?.username ?? null
}

// ─── Routes ─────────────────────────────────────────────────────────────

export type CommunityDmDeps = {
  licenseDb: Database
}

export function mountCommunityDmRoutes(app: Hono, deps: CommunityDmDeps) {
  ensureDmSchema(deps.licenseDb)
  const auth = userAuth({ licenseDb: deps.licenseDb })
  const db = deps.licenseDb

  // ── GET /community/dm/inbox — auth required ──────────────────────────
  // Lista conversazioni dell'utente loggato, ordinata per last_message_at DESC.
  // Include: peer username + avatar_seed + ultimo messaggio + count non letti.
  app.get("/community/dm/inbox", auth, (c) => {
    const me = c.var.customer.id
    const rows = db
      .query<
        {
          conversation_id: number
          peer_id: string
          peer_username: string
          peer_avatar_seed: string
          last_message_at: number
          last_body: string | null
          last_sender: string | null
          unread_count: number
        },
        [string, string, string]
      >(
        `SELECT
          conv.id AS conversation_id,
          CASE WHEN conv.user_a = ?1 THEN conv.user_b ELSE conv.user_a END AS peer_id,
          peer_user.username AS peer_username,
          peer_user.avatar_seed AS peer_avatar_seed,
          conv.last_message_at,
          last_msg.body AS last_body,
          last_msg.sender_id AS last_sender,
          (SELECT COUNT(*) FROM community_dm_message m
            WHERE m.conversation_id = conv.id
              AND m.sender_id != ?2
              AND m.read_at IS NULL) AS unread_count
         FROM community_dm_conversation conv
         JOIN community_user peer_user
           ON peer_user.customer_id = (CASE WHEN conv.user_a = ?3 THEN conv.user_b ELSE conv.user_a END)
         LEFT JOIN community_dm_message last_msg
           ON last_msg.id = (SELECT MAX(id) FROM community_dm_message WHERE conversation_id = conv.id)
         WHERE (conv.user_a = ?1 OR conv.user_b = ?1)
           AND peer_user.username IS NOT NULL
         ORDER BY conv.last_message_at DESC
         LIMIT 100`,
      )
      .all(me, me, me)
    return c.json({ conversations: rows })
  })

  // ── GET /community/dm/with/:username — auth required ────────────────
  // Apre/crea la conversazione con un utente by username, ritorna gli ultimi
  // 100 messaggi e marca come letti i ricevuti.
  app.get("/community/dm/with/:username", auth, (c) => {
    const me = c.var.customer.id
    const username = c.req.param("username")
    const peerId = getCustomerIdByUsername(db, username)
    if (!peerId) return c.json({ error: "utente non trovato" }, 404)
    if (peerId === me) return c.json({ error: "non puoi mandarti DM a te stesso" }, 400)
    if (isBlocked(db, peerId, me)) return c.json({ error: "non puoi contattare questo utente" }, 403)

    const conversationId = getOrCreateConversation(db, me, peerId)
    const messages = db
      .query<
        { id: number; sender_id: string; body: string; ts: number; read_at: number | null },
        [number]
      >(
        "SELECT id, sender_id, body, ts, read_at FROM community_dm_message WHERE conversation_id = ? ORDER BY ts ASC LIMIT 100",
      )
      .all(conversationId)

    // Mark received messages as read (idempotente)
    const now = Date.now()
    db.prepare(
      "UPDATE community_dm_message SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL",
    ).run(now, conversationId, me)
    // Notifica al peer che ha letto
    if (messages.some((m) => m.sender_id !== me && m.read_at === null)) {
      const lastUnreadId = Math.max(...messages.filter((m) => m.sender_id !== me).map((m) => m.id))
      dispatchToUser(peerId, {
        type: "read",
        conversation_id: conversationId,
        up_to_message_id: lastUnreadId,
        reader_id: me,
      })
    }

    return c.json({
      conversation_id: conversationId,
      peer: { customer_id: peerId, username },
      messages: messages.map((m) => ({
        id: m.id,
        is_mine: m.sender_id === me,
        body: m.body,
        ts: m.ts,
        read_at: m.read_at,
      })),
    })
  })

  // ── POST /community/dm/send — auth required ──────────────────────────
  // Invia DM. body: { to_username, body }
  app.post("/community/dm/send", auth, async (c) => {
    const me = c.var.customer.id
    const myUsername = getUsernameByCustomerId(db, me)
    if (!myUsername) return c.json({ error: "Imposta prima un username pubblico" }, 403)

    const payload = await c.req.json<{ to_username?: unknown; body?: unknown }>().catch(() => ({}))
    const toUsername = typeof payload?.to_username === "string" ? payload.to_username : ""
    const peerId = getCustomerIdByUsername(db, toUsername)
    if (!peerId) return c.json({ error: "destinatario non trovato" }, 404)
    if (peerId === me) return c.json({ error: "non puoi mandarti DM a te stesso" }, 400)
    if (isBlocked(db, peerId, me)) return c.json({ error: "non puoi contattare questo utente" }, 403)
    if (isBlocked(db, me, peerId)) return c.json({ error: "hai bloccato questo utente; sblocca prima" }, 403)

    const validation = validateDm(payload?.body)
    if (!validation.ok) return c.json({ error: validation.error }, 400)

    const now = Date.now()

    // Slow mode + rate limit
    const lastMsg = db
      .query<{ ts: number }, [string]>(
        "SELECT MAX(ts) AS ts FROM community_dm_message WHERE sender_id = ?",
      )
      .get(me)
    if (lastMsg?.ts && now - lastMsg.ts < SLOW_MODE_MS) {
      const wait = Math.ceil((SLOW_MODE_MS - (now - lastMsg.ts)) / 1000) || 1
      return c.json({ error: `slow mode: aspetta ${wait}s` }, 429)
    }
    const recentCount = (db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM community_dm_message WHERE sender_id = ? AND ts >= ?",
      )
      .get(me, now - RATE_LIMIT_WINDOW_MS)?.n ?? 0)
    if (recentCount >= RATE_LIMIT_MAX) {
      return c.json({ error: `rate limit: max ${RATE_LIMIT_MAX} DM/min` }, 429)
    }

    const conversationId = getOrCreateConversation(db, me, peerId)
    const result = db
      .prepare(
        "INSERT INTO community_dm_message (conversation_id, sender_id, body, ts) VALUES (?, ?, ?, ?)",
      )
      .run(conversationId, me, validation.body, now)
    db.prepare("UPDATE community_dm_conversation SET last_message_at = ? WHERE id = ?").run(
      now,
      conversationId,
    )

    const ev: DmEvent = {
      type: "message",
      conversation_id: conversationId,
      message: {
        id: Number(result.lastInsertRowid),
        sender_username: myUsername,
        body: validation.body,
        ts: now,
      },
    }
    // Notifica entrambi (sender vede il proprio messaggio anche da altre device)
    dispatchToUser(peerId, ev)
    dispatchToUser(me, ev)

    return c.json({ ok: true, message: ev.message, conversation_id: conversationId })
  })

  // ── GET /community/dm/stream — auth required (SSE per-user) ─────────
  // Stream personale: riceve solo eventi destinati a questo utente.
  // Token Bearer NON funziona con EventSource standard. Soluzione: il
  // client passa il token come query param ?token=xxx. Sicurezza: il token
  // è già visibile nel localStorage del browser, esposto solo in URL HTTPS,
  // non leakable a third-party (CSP origin restrictions).
  app.get("/community/dm/stream", async (c: Context) => {
    // Auth manuale via query param perché EventSource non supporta Authorization header
    const token = c.req.query("token")
    if (!token) return c.json({ error: "token query param required" }, 401)
    const { verifyTokenCrypto } = await import("../license-auth.ts")
    const result = verifyTokenCrypto(token)
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401)
    const session = db
      .query<{ customer_id: string; revoked_at: number | null }, [string]>(
        "SELECT customer_id, revoked_at FROM auth_sessions WHERE id = ?",
      )
      .get(result.payload.sid)
    if (!session || session.revoked_at) return c.json({ error: "session invalid" }, 401)
    const userId = session.customer_id

    return streamSSE(c, async (stream) => {
      const sub: Subscriber = {
        userId,
        send: (ev) => {
          void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })
        },
      }
      addSub(userId, sub)
      // Initial flush
      void stream.writeSSE({ event: "ready", data: String(Date.now()) }).catch(() => {})
      const hb = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {})
      }, 25_000)
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()))
      } finally {
        clearInterval(hb)
        removeSub(userId, sub)
      }
    })
  })

  // ── POST /community/dm/block/:username — auth required ───────────────
  app.post("/community/dm/block/:username", auth, (c) => {
    const me = c.var.customer.id
    const targetId = getCustomerIdByUsername(db, c.req.param("username"))
    if (!targetId) return c.json({ error: "utente non trovato" }, 404)
    if (targetId === me) return c.json({ error: "non puoi bloccarti" }, 400)
    db.prepare(
      "INSERT OR IGNORE INTO community_dm_block (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
    ).run(me, targetId, Date.now())
    return c.json({ ok: true })
  })

  // ── DELETE /community/dm/block/:username — auth required (unblock) ──
  app.delete("/community/dm/block/:username", auth, (c) => {
    const me = c.var.customer.id
    const targetId = getCustomerIdByUsername(db, c.req.param("username"))
    if (!targetId) return c.json({ error: "utente non trovato" }, 404)
    db.prepare(
      "DELETE FROM community_dm_block WHERE blocker_id = ? AND blocked_id = ?",
    ).run(me, targetId)
    return c.json({ ok: true })
  })
}
