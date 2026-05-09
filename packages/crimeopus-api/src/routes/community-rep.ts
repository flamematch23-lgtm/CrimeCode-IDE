/**
 * Community Rep — Phase 3
 *
 * Sistema +rep tra utenti. Ogni utente con username può dare rep a un altro.
 *
 * Anti-gaming:
 *   - Non puoi dare rep a te stesso
 *   - Max 1 rep allo STESSO target / 24h
 *   - Max 7 rep totali / 24h (impedisce spam globale)
 *   - Solo utenti con username settato possono dare/ricevere
 *   - Solo utenti che hanno almeno 1 evento attività nelle ultime 7 giorni
 *     possono dare rep (no farm da account inattivi)
 *
 * Storico:
 *   - Ogni rep è un row in `community_rep` con (giver, receiver, ts, note?)
 *   - Aggiornato counter aggregato `community_user.rep_received` su ogni grant
 *
 * Endpoints:
 *   POST   /community/u/:username/rep     [auth] dai +1 rep
 *   GET    /community/u/:username/rep     [public] storico ultimi 50 rep ricevuti
 *   GET    /community/me/rep/given        [auth] storico rep dati da me
 *   GET    /community/me/rep/budget       [auth] quanti rep posso ancora dare oggi
 */
import type { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { userAuth } from "../middleware/user-auth.ts"

const REP_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_rep (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  giver_id    TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  note        TEXT,
  ts          INTEGER NOT NULL,
  FOREIGN KEY (giver_id) REFERENCES customers(id),
  FOREIGN KEY (receiver_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS rep_giver_ts_idx ON community_rep(giver_id, ts);
CREATE INDEX IF NOT EXISTS rep_receiver_ts_idx ON community_rep(receiver_id, ts);
CREATE INDEX IF NOT EXISTS rep_pair_idx ON community_rep(giver_id, receiver_id, ts);
`

export function ensureRepSchema(db: Database) {
  db.exec(REP_SCHEMA)
}

const DAILY_BUDGET = 7
const PAIR_COOLDOWN_MS = 24 * 60 * 60 * 1000
const MIN_ACTIVITY_DAYS_FOR_GIVING = 7
const MAX_NOTE_LENGTH = 200

function dayAgo(): number {
  return Date.now() - 24 * 60 * 60 * 1000
}

export type CommunityRepDeps = { licenseDb: Database }

export function mountCommunityRepRoutes(app: Hono, deps: CommunityRepDeps) {
  ensureRepSchema(deps.licenseDb)
  const auth = userAuth({ licenseDb: deps.licenseDb })
  const db = deps.licenseDb

  function getCustomerIdByUsername(username: string): string | null {
    return (
      db
        .query<{ customer_id: string }, [string]>(
          "SELECT customer_id FROM community_user WHERE LOWER(username) = LOWER(?)",
        )
        .get(username)?.customer_id ?? null
    )
  }

  // ── GET /community/me/rep/budget — auth required ────────────────────
  // Ritorna quanti rep posso ancora dare oggi + cooldown per target.
  app.get("/community/me/rep/budget", auth, (c) => {
    const me = c.var.customer.id
    const since = dayAgo()
    const givenToday = (db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM community_rep WHERE giver_id = ? AND ts >= ?",
      )
      .get(me, since)?.n ?? 0)
    return c.json({
      budget_total: DAILY_BUDGET,
      given_today: givenToday,
      remaining: Math.max(0, DAILY_BUDGET - givenToday),
      reset_in_ms: PAIR_COOLDOWN_MS,
    })
  })

  // ── POST /community/u/:username/rep — auth required ─────────────────
  // Dai +1 rep al target. body: { note? }
  app.post("/community/u/:username/rep", auth, async (c) => {
    const me = c.var.customer.id
    const targetUsername = c.req.param("username")
    const targetId = getCustomerIdByUsername(targetUsername)
    if (!targetId) return c.json({ error: "utente non trovato" }, 404)
    if (targetId === me) return c.json({ error: "non puoi dare rep a te stesso" }, 400)

    // Check giver ha username settato
    const myUsername = db
      .query<{ username: string | null }, [string]>(
        "SELECT username FROM community_user WHERE customer_id = ?",
      )
      .get(me)
    if (!myUsername?.username) {
      return c.json({ error: "Imposta prima un username pubblico" }, 403)
    }

    // Check activity: almeno 1 evento nei 7 giorni
    const sevenDaysAgo = Date.now() - MIN_ACTIVITY_DAYS_FOR_GIVING * 24 * 60 * 60 * 1000
    const activity = db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM community_event WHERE customer_id = ? AND ts >= ?",
      )
      .get(me, sevenDaysAgo)
    if (!activity || activity.n === 0) {
      return c.json({
        error: `Per dare rep devi essere stato attivo negli ultimi ${MIN_ACTIVITY_DAYS_FOR_GIVING} giorni.`,
      }, 403)
    }

    const since = dayAgo()

    // Cooldown stesso target
    const lastToTarget = db
      .query<{ ts: number }, [string, string, number]>(
        "SELECT MAX(ts) AS ts FROM community_rep WHERE giver_id = ? AND receiver_id = ? AND ts >= ?",
      )
      .get(me, targetId, since)
    if (lastToTarget?.ts) {
      const wait = Math.ceil((PAIR_COOLDOWN_MS - (Date.now() - lastToTarget.ts)) / 60_000)
      return c.json(
        { error: `Hai già dato rep a @${targetUsername} di recente. Riprova tra ${wait}m.` },
        429,
      )
    }

    // Daily budget
    const givenToday = (db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM community_rep WHERE giver_id = ? AND ts >= ?",
      )
      .get(me, since)?.n ?? 0)
    if (givenToday >= DAILY_BUDGET) {
      return c.json(
        { error: `Hai esaurito i ${DAILY_BUDGET} rep quotidiani. Riprova domani.` },
        429,
      )
    }

    const body = await c.req.json<{ note?: unknown }>().catch(() => ({} as { note?: unknown }))
    const note =
      typeof body?.note === "string" && body.note.trim().length > 0
        ? body.note.trim().slice(0, MAX_NOTE_LENGTH)
        : null

    const now = Date.now()
    db.prepare(
      "INSERT INTO community_rep (giver_id, receiver_id, note, ts) VALUES (?, ?, ?, ?)",
    ).run(me, targetId, note, now)
    db.prepare("UPDATE community_user SET rep_received = rep_received + 1 WHERE customer_id = ?").run(targetId)

    // Anche logga un community_event "rep_received" per il target con
    // peso 3, così la rep contribuisce allo score della leaderboard
    // nel periodo selezionato (30g / all). Il frontend explainer
    // dichiara esattamente questo valore.
    try {
      db.prepare(
        "INSERT INTO community_event (customer_id, event_type, weight, ts) VALUES (?, ?, ?, ?)",
      ).run(targetId, "rep_received", 3, now)
    } catch {
      // Best-effort: se il log evento fallisce, la rep è già salvata.
    }

    return c.json({
      ok: true,
      remaining_today: Math.max(0, DAILY_BUDGET - givenToday - 1),
      target: targetUsername,
    })
  })

  // ── GET /community/u/:username/rep — public ─────────────────────────
  // Storico ultimi 50 rep ricevuti dall'utente. Include username del giver
  // (NON customer_id, per privacy) e nota se presente.
  app.get("/community/u/:username/rep", (c) => {
    const targetId = getCustomerIdByUsername(c.req.param("username"))
    if (!targetId) return c.json({ error: "utente non trovato" }, 404)
    const rows = db
      .query<
        { giver_username: string; note: string | null; ts: number },
        [string]
      >(
        `SELECT
          gu.username AS giver_username,
          r.note,
          r.ts
         FROM community_rep r
         JOIN community_user gu ON gu.customer_id = r.giver_id
         WHERE r.receiver_id = ?
         ORDER BY r.ts DESC
         LIMIT 50`,
      )
      .all(targetId)
    return c.json({ entries: rows })
  })

  // ── GET /community/me/rep/given — auth required ─────────────────────
  // Storico ultimi rep dati da me.
  app.get("/community/me/rep/given", auth, (c) => {
    const me = c.var.customer.id
    const rows = db
      .query<
        { receiver_username: string; note: string | null; ts: number },
        [string]
      >(
        `SELECT
          ru.username AS receiver_username,
          r.note,
          r.ts
         FROM community_rep r
         JOIN community_user ru ON ru.customer_id = r.receiver_id
         WHERE r.giver_id = ?
         ORDER BY r.ts DESC
         LIMIT 50`,
      )
      .all(me)
    return c.json({ entries: rows })
  })
}
