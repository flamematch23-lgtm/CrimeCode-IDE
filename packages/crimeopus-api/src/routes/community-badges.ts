/**
 * Community Badges — Phase 3
 *
 * Sistema di badge automatici. Le regole vivono in `BADGE_RULES`. Ogni badge
 * ha un id, label, descrizione, icona/emoji, e una funzione `check(customerId,
 * db)` che ritorna true se il badge va assegnato.
 *
 * Award flow:
 *   - L'utente chiama POST /community/me/badges/refresh per re-evaluate
 *   - Il client può chiamarlo dopo eventi significativi (session_created, etc.)
 *   - Idempotente: se il badge è già stato assegnato, no-op
 *
 * Display:
 *   - GET /community/u/:username/badges ritorna i badge dell'utente
 *   - Badge mostrati come chip nel profilo pubblico + leaderboard row
 *
 * Espandibilità: per aggiungere un badge, basta aggiungere una entry in
 * BADGE_RULES. Niente migration, niente UI changes (la UI rendera tutti i
 * badge che riceve).
 */
import type { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { userAuth } from "../middleware/user-auth.ts"

const BADGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_badge (
  customer_id TEXT NOT NULL,
  badge_id    TEXT NOT NULL,
  awarded_at  INTEGER NOT NULL,
  PRIMARY KEY (customer_id, badge_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS badge_customer_idx ON community_badge(customer_id);
`

export function ensureBadgesSchema(db: Database) {
  db.exec(BADGES_SCHEMA)
}

// ─── Badge definitions ──────────────────────────────────────────────────

export type BadgeMeta = {
  id: string
  label: string
  description: string
  emoji: string
  /** Check returns true se l'utente ha guadagnato il badge ORA. */
  check: (customerId: string, db: Database) => boolean
}

const BADGE_RULES: BadgeMeta[] = [
  {
    id: "early_adopter",
    label: "Early Adopter",
    description: "Tra i primi 100 utenti a registrarsi nella community",
    emoji: "🌱",
    check: (customerId, db) => {
      // Top 100 by community_user.created_at
      const r = db
        .query<{ rank: number }, [string]>(
          `SELECT (SELECT COUNT(*) FROM community_user u2
                   WHERE u2.created_at < u1.created_at) + 1 AS rank
            FROM community_user u1
            WHERE u1.customer_id = ?`,
        )
        .get(customerId)
      return !!r && r.rank <= 100
    },
  },
  {
    id: "active_week",
    label: "Active Week",
    description: "Almeno 1 evento attività ogni giorno per 7 giorni consecutivi",
    emoji: "🔥",
    check: (customerId, db) => {
      // Check 7 distinct days of activity nelle ultime 14 days
      const since = Date.now() - 14 * 24 * 60 * 60 * 1000
      const rows = db
        .query<{ day: number }, [string, number]>(
          `SELECT DISTINCT (ts / 86400000) AS day
            FROM community_event
            WHERE customer_id = ? AND ts >= ?
            ORDER BY day ASC`,
        )
        .all(customerId, since)
      if (rows.length < 7) return false
      // Check almeno 7 giorni consecutivi
      let consecutive = 1
      let maxStreak = 1
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].day === rows[i - 1].day + 1) {
          consecutive++
          maxStreak = Math.max(maxStreak, consecutive)
        } else if (rows[i].day !== rows[i - 1].day) {
          consecutive = 1
        }
      }
      return maxStreak >= 7
    },
  },
  {
    id: "helper",
    label: "Helper",
    description: "Hai ricevuto almeno 10 +rep dalla community",
    emoji: "🤝",
    check: (customerId, db) => {
      const r = db
        .query<{ rep: number }, [string]>(
          "SELECT rep_received AS rep FROM community_user WHERE customer_id = ?",
        )
        .get(customerId)
      return !!r && r.rep >= 10
    },
  },
]

const BADGE_BY_ID = new Map(BADGE_RULES.map((b) => [b.id, b]))

// ─── Award logic ────────────────────────────────────────────────────────

function alreadyAwarded(db: Database, customerId: string, badgeId: string): boolean {
  return !!db
    .query<{ customer_id: string }, [string, string]>(
      "SELECT customer_id FROM community_badge WHERE customer_id = ? AND badge_id = ?",
    )
    .get(customerId, badgeId)
}

function award(db: Database, customerId: string, badgeId: string) {
  db.prepare(
    "INSERT OR IGNORE INTO community_badge (customer_id, badge_id, awarded_at) VALUES (?, ?, ?)",
  ).run(customerId, badgeId, Date.now())
}

export function evaluateBadges(db: Database, customerId: string): string[] {
  const newlyAwarded: string[] = []
  for (const badge of BADGE_RULES) {
    if (alreadyAwarded(db, customerId, badge.id)) continue
    try {
      if (badge.check(customerId, db)) {
        award(db, customerId, badge.id)
        newlyAwarded.push(badge.id)
      }
    } catch {
      // Una regola buggy non deve bloccare le altre
    }
  }
  return newlyAwarded
}

// ─── Routes ─────────────────────────────────────────────────────────────

export type CommunityBadgesDeps = { licenseDb: Database }

export function mountCommunityBadgesRoutes(app: Hono, deps: CommunityBadgesDeps) {
  ensureBadgesSchema(deps.licenseDb)
  const auth = userAuth({ licenseDb: deps.licenseDb })
  const db = deps.licenseDb

  // ── POST /community/me/badges/refresh — auth required ───────────────
  // Re-evaluate tutti i badge per l'utente loggato. Idempotente.
  app.post("/community/me/badges/refresh", auth, (c) => {
    const me = c.var.customer.id
    const newlyAwarded = evaluateBadges(db, me)
    return c.json({
      ok: true,
      newly_awarded: newlyAwarded.map((id) => {
        const meta = BADGE_BY_ID.get(id)
        return { id, label: meta?.label, emoji: meta?.emoji }
      }),
    })
  })

  // ── GET /community/u/:username/badges — public ──────────────────────
  app.get("/community/u/:username/badges", (c) => {
    const username = c.req.param("username")
    const customer = db
      .query<{ customer_id: string }, [string]>(
        "SELECT customer_id FROM community_user WHERE LOWER(username) = LOWER(?)",
      )
      .get(username)
    if (!customer) return c.json({ error: "utente non trovato" }, 404)
    const rows = db
      .query<
        { badge_id: string; awarded_at: number },
        [string]
      >(
        "SELECT badge_id, awarded_at FROM community_badge WHERE customer_id = ? ORDER BY awarded_at ASC",
      )
      .all(customer.customer_id)
    return c.json({
      badges: rows.map((r) => {
        const meta = BADGE_BY_ID.get(r.badge_id)
        return {
          id: r.badge_id,
          label: meta?.label ?? r.badge_id,
          description: meta?.description ?? "",
          emoji: meta?.emoji ?? "🏅",
          awarded_at: r.awarded_at,
        }
      }),
    })
  })

  // ── GET /community/badges/catalog — public ──────────────────────────
  // Lista tutti i badge disponibili (per discovery / "come ottengo X")
  app.get("/community/badges/catalog", (c) => {
    return c.json({
      badges: BADGE_RULES.map((b) => ({
        id: b.id,
        label: b.label,
        description: b.description,
        emoji: b.emoji,
      })),
    })
  })
}
