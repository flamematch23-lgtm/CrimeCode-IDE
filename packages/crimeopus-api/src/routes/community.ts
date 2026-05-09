/**
 * Community routes — Phase 1 (Profilo + Leaderboard read-only).
 *
 * Schema (in licenseDb, joins con `customers`):
 *   community_user    — username pubblico + avatar seed scelto dall'utente
 *   community_event   — log eventi attività (session_created, message_sent, ...)
 *
 * Endpoints (tutti dietro userAuth middleware salvo /leaderboard pubblico):
 *   GET  /community/me            — profilo dell'utente loggato (crea entry se non esiste)
 *   PUT  /community/me/username   — set/cambia username pubblico
 *   POST /community/me/event      — log un evento attività (chiamato dal client)
 *   GET  /community/leaderboard   — top 100 by activity score (PUBLIC)
 *   GET  /community/u/:username   — profilo pubblico per username
 *
 * Phase 2 (chat globale) e Phase 3 (DM + rep) atterrano in community-chat.ts
 * e community-rep.ts in turni dedicati. Questo modulo resta read-mostly.
 */
import type { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { userAuth } from "../middleware/user-auth.ts"

// ─── Schema ────────────────────────────────────────────────────────────

const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_user (
  customer_id  TEXT PRIMARY KEY,
  username     TEXT UNIQUE COLLATE NOCASE,
  avatar_seed  TEXT NOT NULL,
  bio          TEXT,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  rep_received INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS community_user_username_idx ON community_user(username);
CREATE INDEX IF NOT EXISTS community_user_last_active_idx ON community_user(last_active);

CREATE TABLE IF NOT EXISTS community_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1,
  ts          INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS community_event_customer_ts_idx ON community_event(customer_id, ts);
CREATE INDEX IF NOT EXISTS community_event_ts_idx ON community_event(ts);
`

export function ensureCommunitySchema(db: Database) {
  db.exec(COMMUNITY_SCHEMA)
}

// ─── Validation ────────────────────────────────────────────────────────

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/
const RESERVED_USERNAMES = new Set([
  "admin", "root", "system", "moderator", "mod", "support",
  "crimecode", "crimeopus", "opencode", "anonymous", "deleted",
  "null", "undefined", "me", "you", "user", "users",
])

function validateUsername(value: string): { ok: true; username: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "username deve essere stringa" }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, error: "username vuoto" }
  if (!USERNAME_RE.test(trimmed)) {
    return { ok: false, error: "username deve essere 3-20 char alphanum, _ o -" }
  }
  if (RESERVED_USERNAMES.has(trimmed.toLowerCase())) {
    return { ok: false, error: "username riservato" }
  }
  return { ok: true, username: trimmed }
}

// Avatar seed: deterministico per customer_id così l'avatar resta stabile
// anche se l'utente cambia username. Il client genera l'avatar dal seed
// (es. dicebear, gravatar-style hashing).
function generateAvatarSeed(customerId: string): string {
  // Hash semplice: prendi prime/last 8 char di customer_id + length
  // Risultato: 16-char seed deterministico, breve, URL-safe.
  const head = customerId.slice(0, 8)
  const tail = customerId.slice(-8)
  return `${head}${tail}-${customerId.length}`
}

// ─── Profile ops ────────────────────────────────────────────────────────

type CommunityProfile = {
  customer_id: string
  username: string | null
  avatar_seed: string
  /** URL all'avatar custom uploadato. Override su avatar_seed (dicebear). */
  avatar_url: string | null
  bio: string | null
  created_at: number
  last_active: number
  rep_received: number
  // Stats aggregate da community_event
  events_total: number
  events_30d: number
}

function getOrCreateProfile(db: Database, customerId: string): CommunityProfile {
  const existing = db
    .query<
      {
        customer_id: string
        username: string | null
        avatar_seed: string
        avatar_url: string | null
        bio: string | null
        created_at: number
        last_active: number
        rep_received: number
      },
      [string]
    >(
      "SELECT customer_id, username, avatar_seed, avatar_url, bio, created_at, last_active, rep_received FROM community_user WHERE customer_id = ?",
    )
    .get(customerId)

  let row: {
    customer_id: string
    username: string | null
    avatar_seed: string
    avatar_url: string | null
    bio: string | null
    created_at: number
    last_active: number
    rep_received: number
  }
  if (existing) {
    row = existing
  } else {
    const now = Date.now()
    const seed = generateAvatarSeed(customerId)
    db.prepare(
      "INSERT INTO community_user (customer_id, username, avatar_seed, bio, created_at, last_active, rep_received) VALUES (?, NULL, ?, NULL, ?, ?, 0)",
    ).run(customerId, seed, now, now)
    row = {
      customer_id: customerId,
      username: null,
      avatar_seed: seed,
      avatar_url: null,
      bio: null,
      created_at: now,
      last_active: now,
      rep_received: 0,
    }
  }

  // Aggregate stats
  const now = Date.now()
  const days30 = now - 30 * 24 * 60 * 60 * 1000
  const total = (db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM community_event WHERE customer_id = ?",
    )
    .get(customerId)?.n ?? 0)
  const recent = (db
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM community_event WHERE customer_id = ? AND ts >= ?",
    )
    .get(customerId, days30)?.n ?? 0)

  return {
    ...row,
    events_total: total,
    events_30d: recent,
  }
}

function touchLastActive(db: Database, customerId: string) {
  db.prepare("UPDATE community_user SET last_active = ? WHERE customer_id = ?").run(Date.now(), customerId)
}

// ─── Routes ─────────────────────────────────────────────────────────────

export type CommunityRoutesDeps = {
  licenseDb: Database
}

export function mountCommunityRoutes(app: Hono, deps: CommunityRoutesDeps) {
  ensureCommunitySchema(deps.licenseDb)
  const auth = userAuth({ licenseDb: deps.licenseDb })
  const db = deps.licenseDb

  // ── GET /community/me — auth required ───────────────────────────────
  // Ritorna il profilo dell'utente loggato. Crea entry se non esiste
  // (lazy bootstrap al primo accesso community).
  app.get("/community/me", auth, (c) => {
    const customer = c.var.customer
    const profile = getOrCreateProfile(db, customer.id)
    touchLastActive(db, customer.id)
    return c.json({ profile })
  })

  // ── PUT /community/me/username — auth required ──────────────────────
  // Set o cambia username pubblico. Validation: 3-20 char alphanum/_/-,
  // unique case-insensitive, non riservato.
  app.put("/community/me/username", auth, async (c) => {
    const customer = c.var.customer
    const body = await c.req.json<{ username?: unknown }>().catch(() => ({} as { username?: unknown }))
    const validation = validateUsername(typeof body?.username === "string" ? body.username : "")
    if (!validation.ok) return c.json({ error: validation.error }, 400)

    // Conflict check (case-insensitive)
    const conflict = db
      .query<{ customer_id: string }, [string]>(
        "SELECT customer_id FROM community_user WHERE LOWER(username) = LOWER(?) AND customer_id != ?",
      )
      .get(validation.username, customer.id)
    if (conflict) return c.json({ error: "username già preso" }, 409)

    // Ensure profile esiste prima dell'update
    getOrCreateProfile(db, customer.id)
    db.prepare("UPDATE community_user SET username = ? WHERE customer_id = ?").run(
      validation.username,
      customer.id,
    )
    return c.json({ ok: true, username: validation.username })
  })

  // ── POST /community/me/event — auth required ────────────────────────
  // Logga un evento attività dal client. Rate-limited a 60 eventi/min/user
  // per anti-gaming. Whitelist di event_type per evitare data injection.
  const ALLOWED_EVENTS = new Set([
    "session_created",
    "message_sent",
    "tool_call",
    "burp_flow_captured",
    "exploit_chain_built",
    "report_generated",
  ])
  app.post("/community/me/event", auth, async (c) => {
    const customer = c.var.customer
    const body = await c.req.json<{ event_type?: unknown; weight?: unknown }>().catch(() => ({}))
    const eventType = typeof body?.event_type === "string" ? body.event_type : ""
    if (!ALLOWED_EVENTS.has(eventType)) return c.json({ error: "event_type non valido" }, 400)
    const weight = typeof body?.weight === "number" && body.weight > 0 && body.weight <= 10 ? Math.floor(body.weight) : 1

    // Rate limit: 60 eventi/min/user
    const oneMinAgo = Date.now() - 60_000
    const recentCount = (db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM community_event WHERE customer_id = ? AND ts >= ?",
      )
      .get(customer.id, oneMinAgo)?.n ?? 0)
    if (recentCount >= 60) return c.json({ error: "rate limit (60/min)" }, 429)

    getOrCreateProfile(db, customer.id)
    db.prepare("INSERT INTO community_event (customer_id, event_type, weight, ts) VALUES (?, ?, ?, ?)").run(
      customer.id,
      eventType,
      weight,
      Date.now(),
    )
    touchLastActive(db, customer.id)
    return c.json({ ok: true })
  })

  // ── GET /community/leaderboard — PUBLIC ─────────────────────────────
  // Top 100 utenti by activity score negli ultimi 30 giorni.
  // Score = somma dei weight degli eventi nel periodo.
  // Solo utenti con username impostato (anonimi esclusi).
  app.get("/community/leaderboard", (c) => {
    const period = c.req.query("period") === "all" ? null : 30 * 24 * 60 * 60 * 1000
    const cutoff = period ? Date.now() - period : 0

    const rows = db
      .query<
        {
          customer_id: string
          username: string
          avatar_seed: string
          avatar_url: string | null
          bio: string | null
          last_active: number
          rep_received: number
          score: number
          events: number
        },
        [number]
      >(
        `SELECT
          u.customer_id,
          u.username,
          u.avatar_seed,
          u.avatar_url,
          u.bio,
          u.last_active,
          u.rep_received,
          COALESCE(SUM(e.weight), 0) AS score,
          COUNT(e.id) AS events
         FROM community_user u
         LEFT JOIN community_event e ON e.customer_id = u.customer_id AND e.ts >= ?
         WHERE u.username IS NOT NULL
         GROUP BY u.customer_id
         ORDER BY score DESC, u.rep_received DESC, u.last_active DESC
         LIMIT 100`,
      )
      .all(cutoff)

    return c.json({
      period: period ? "30d" : "all",
      generated_at: Date.now(),
      entries: rows.map((r, i) => ({
        rank: i + 1,
        username: r.username,
        avatar_seed: r.avatar_seed,
        avatar_url: r.avatar_url,
        bio: r.bio,
        score: r.score,
        events: r.events,
        rep: r.rep_received,
        last_active: r.last_active,
      })),
    })
  })

  // ── GET /community/u/:username — PUBLIC profile ─────────────────────
  app.get("/community/u/:username", (c) => {
    const username = c.req.param("username")
    if (!username) return c.json({ error: "username richiesto" }, 400)
    const row = db
      .query<
        {
          customer_id: string
          username: string
          avatar_seed: string
          avatar_url: string | null
          bio: string | null
          created_at: number
          last_active: number
          rep_received: number
        },
        [string]
      >(
        "SELECT customer_id, username, avatar_seed, avatar_url, bio, created_at, last_active, rep_received FROM community_user WHERE LOWER(username) = LOWER(?)",
      )
      .get(username)
    if (!row) return c.json({ error: "utente non trovato" }, 404)

    const now = Date.now()
    const days30 = now - 30 * 24 * 60 * 60 * 1000
    const totalEvents = (db
      .query<{ n: number; score: number }, [string]>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(weight), 0) AS score FROM community_event WHERE customer_id = ?",
      )
      .get(row.customer_id) ?? { n: 0, score: 0 })
    const recentEvents = (db
      .query<{ n: number; score: number }, [string, number]>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(weight), 0) AS score FROM community_event WHERE customer_id = ? AND ts >= ?",
      )
      .get(row.customer_id, days30) ?? { n: 0, score: 0 })

    return c.json({
      profile: {
        username: row.username,
        avatar_seed: row.avatar_seed,
        avatar_url: row.avatar_url,
        bio: row.bio,
        created_at: row.created_at,
        last_active: row.last_active,
        rep: row.rep_received,
        stats: {
          events_total: totalEvents.n,
          events_30d: recentEvents.n,
          score_total: totalEvents.score,
          score_30d: recentEvents.score,
        },
      },
    })
  })
}
