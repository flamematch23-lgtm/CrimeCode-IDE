/**
 * Builder Templates — chip suggestions for the "New project" composer.
 *
 * The composer modal in CrimeCode shows 3-4 quick-start chips per tab
 * (Pentest Engagement / Exploit Chain / OSINT / Web App / API / Mobile).
 * Templates live server-side so we can curate / refresh them without
 * shipping a new desktop release.
 *
 * Schema:
 *   builder_template (
 *     id          INTEGER PK,
 *     tab         TEXT NOT NULL,    -- "pentest" | "exploit" | "osint" | "webapp" | "api" | "mobile"
 *     label       TEXT NOT NULL,    -- short chip text, e.g. "AI Plant Doctor"
 *     prompt_seed TEXT NOT NULL,    -- pre-fill body for the textarea on click
 *     sort        INTEGER DEFAULT 0,-- stable ordering (lower = first)
 *     active      INTEGER DEFAULT 1,-- soft-disable a chip without delete
 *     created_at  INTEGER NOT NULL
 *   )
 *
 * Endpoints:
 *   GET /api/builder/templates?tab=<tab>&limit=4   — public, returns
 *     up to N random ACTIVE chips for the tab (re-shuffled per request
 *     so the user gets fresh suggestions on every modal open).
 *   GET /api/builder/templates/all                  — admin (basic-auth),
 *     full list including inactive, for curation.
 */
import type { Hono } from "hono"
import type { Database } from "bun:sqlite"

const VALID_TABS = new Set(["pentest", "exploit", "osint", "webapp", "api", "mobile"])

// Default seed: 5-7 chips per tab. Anything the curator wants to add later
// goes through `INSERT INTO builder_template ...` directly on the VPS.
const SEED: Array<{ tab: string; label: string; prompt_seed: string; sort: number }> = [
  // ── Pentest Engagement ────────────────────────────────────────────
  {
    tab: "pentest",
    sort: 1,
    label: "Web app full pentest",
    prompt_seed:
      "Esegui un penetration test completo sull'applicazione web https://example.com. Recon passivo, content discovery, scan vulnerabilità OWASP Top 10, exploit dei finding, write-up finale con CVSS.",
  },
  {
    tab: "pentest",
    sort: 2,
    label: "API REST audit",
    prompt_seed:
      "Audit di sicurezza dell'API REST https://api.example.com. Mappa tutti gli endpoint, testa auth/AuthZ/rate limit/input validation, identifica BOLA, mass assignment, IDOR. Report con repro steps.",
  },
  {
    tab: "pentest",
    sort: 3,
    label: "WordPress hardening check",
    prompt_seed:
      "Analisi sicurezza site WordPress https://example.com: enumera plugin/theme, identifica versioni vulnerabili, controlla user enumeration, brute-force protection, XML-RPC, REST API, file uploads.",
  },
  {
    tab: "pentest",
    sort: 4,
    label: "Subdomain takeover hunt",
    prompt_seed:
      "Cerca subdomain takeover su example.com: enumera subdomain (CT logs + bruteforce), identifica CNAME orfani verso S3/Heroku/GitHub Pages/Azure, verifica claimability.",
  },
  {
    tab: "pentest",
    sort: 5,
    label: "JWT vulnerability scan",
    prompt_seed:
      "Audit JWT su https://example.com: testa alg=none, weak secret bruteforce, key confusion, kid injection, expired/exp manipulation, JKU/X5U injection.",
  },
  {
    tab: "pentest",
    sort: 6,
    label: "Bug bounty recon report",
    prompt_seed:
      "Bug bounty recon su example.com: subdomain enum, port scan, tech stack fingerprint, file/dir bruteforce, JS file analysis per endpoint segreti, GitHub dorks per leak. Output: lista attack surface con prio.",
  },

  // ── Exploit Chain ─────────────────────────────────────────────────
  {
    tab: "exploit",
    sort: 1,
    label: "SSRF → cloud metadata",
    prompt_seed:
      "Costruisci PoC che concatena: SSRF nell'endpoint /api/preview → bypass filter localhost via DNS rebinding → fetch http://169.254.169.254/latest/meta-data/iam/security-credentials/ → dump AWS keys → list S3 buckets.",
  },
  {
    tab: "exploit",
    sort: 2,
    label: "XXE → file read → RCE",
    prompt_seed:
      "PoC chain: XXE in endpoint XML upload → read /etc/passwd → poison shared mount → trigger cron pickup → RCE. Includi payload completo + step esecuzione.",
  },
  {
    tab: "exploit",
    sort: 3,
    label: "Stored XSS → admin takeover",
    prompt_seed:
      "Chain stored XSS in commento blog → admin visita pagina → exfil sessionId → re-use cookie → CSRF su endpoint /admin/users/promote → escalation a superadmin.",
  },
  {
    tab: "exploit",
    sort: 4,
    label: "Path traversal → log poison → RCE",
    prompt_seed:
      "PoC: path traversal su /download?file=../../var/log/apache/access.log → user-agent injection con PHP code → log incluso via LFI → RCE. Tutto in un curl one-liner.",
  },
  {
    tab: "exploit",
    sort: 5,
    label: "Race condition → double spend",
    prompt_seed:
      "PoC race condition su /api/wallet/transfer: 50 request parallele con stesso amount, demo double-spend. Script con threading.Thread + barrier sync per max parallelism.",
  },

  // ── OSINT Investigation ──────────────────────────────────────────
  {
    tab: "osint",
    sort: 1,
    label: "Profilo dominio",
    prompt_seed:
      "OSINT su example.com: WHOIS history, DNS records, SSL cert SANs, technology stack (Wappalyzer-style), subdomain enum, leak databases (HIBP, dehashed), GitHub commits con email aziendale.",
  },
  {
    tab: "osint",
    sort: 2,
    label: "Profilo persona (email)",
    prompt_seed:
      "OSINT su email john@example.com: HIBP breach, social account discovery (sherlock-style), Gravatar, reuse account su forum, Pastebin leaks, GitHub commits, link a profili LinkedIn/Twitter.",
  },
  {
    tab: "osint",
    sort: 3,
    label: "Investigazione azienda",
    prompt_seed:
      "Profilazione azienda Acme Corp: WHOIS / hosting / cloud accounts, dipendenti su LinkedIn (org chart), tech stack pubblico, GitHub org repos, breach databases, leak credenziali ex-dipendenti.",
  },
  {
    tab: "osint",
    sort: 4,
    label: "Crypto wallet trace",
    prompt_seed:
      "Trace wallet 0xABC...: cluster con altri wallet (input clustering), interazioni con exchange (coinbase/binance hot wallets), DeFi protocol usage, possibili identità via ENS / Twitter linking.",
  },
  {
    tab: "osint",
    sort: 5,
    label: "Image reverse + EXIF",
    prompt_seed:
      "Investigazione immagine fornita dall'utente: estrai EXIF (GPS, camera, software), reverse image search (TinEye-like), OCR del contenuto, identifica luogo da landmark visibili, deepfake check.",
  },

  // ── Web App ──────────────────────────────────────────────────────
  {
    tab: "webapp",
    sort: 1,
    label: "Admin dashboard",
    prompt_seed:
      "Crea una dashboard admin con Next.js 15 + TypeScript + Tailwind + shadcn/ui: auth via Clerk, sidebar navigazione, tabelle utenti/ordini con filtri/paginazione, grafici (recharts), dark mode toggle.",
  },
  {
    tab: "webapp",
    sort: 2,
    label: "SaaS landing + auth",
    prompt_seed:
      "Landing page SaaS + sistema auth completo: hero, pricing 3 tier, FAQ, testimonials, signup/login con email+password e Google OAuth, dashboard utente con billing tramite Stripe Subscription.",
  },
  {
    tab: "webapp",
    sort: 3,
    label: "Real-time chat app",
    prompt_seed:
      "App chat real-time tipo Discord: server/channels, messaggi via WebSocket, typing indicator, message reactions, file upload, ricerca messaggi. Stack: Next.js + Socket.IO + Postgres + Redis.",
  },
  {
    tab: "webapp",
    sort: 4,
    label: "AI document Q&A",
    prompt_seed:
      "App per upload PDF/docx e fare Q&A con AI sul contenuto: parsing testo + chunking + embedding (OpenAI text-embedding-3) + Pinecone storage + chat UI con citazioni + history.",
  },
  {
    tab: "webapp",
    sort: 5,
    label: "Marketplace 2-sided",
    prompt_seed:
      "Marketplace 2-sided (tipo Fiverr): seller profile, listing creation, search/filter, ordering, review system, in-app messaging, escrow payment con Stripe Connect, dashboard seller con analytics.",
  },

  // ── API ──────────────────────────────────────────────────────────
  {
    tab: "api",
    sort: 1,
    label: "REST API CRUD + auth",
    prompt_seed:
      "API REST con FastAPI + PostgreSQL + JWT auth: CRUD users/posts/comments, role-based access control (admin/user), rate limiting, OpenAPI docs auto, test suite con pytest.",
  },
  {
    tab: "api",
    sort: 2,
    label: "GraphQL API",
    prompt_seed:
      "API GraphQL con Apollo Server + TypeScript + Prisma (Postgres): schema users/products/orders, mutation+query+subscription, dataloader per N+1, auth via JWT in context, persisted queries per security.",
  },
  {
    tab: "api",
    sort: 3,
    label: "Webhook receiver",
    prompt_seed:
      "API che riceve webhooks (Stripe/GitHub/Linear): signature verification, idempotency via redis, retry queue (BullMQ), dashboard per inspect deliveries con replay button.",
  },
  {
    tab: "api",
    sort: 4,
    label: "ML inference API",
    prompt_seed:
      "API FastAPI per inference modello ML (Hugging Face transformer): preprocessing input, async inference, batching dinamico, response caching, Prometheus metrics, deployment con Docker.",
  },
  {
    tab: "api",
    sort: 5,
    label: "Scraping API",
    prompt_seed:
      "API scraping con Playwright + Bun: endpoint POST /scrape che accetta URL + selectors, ritorna JSON estratto. Rate limit per IP, proxy rotation, screenshot opzionale, queue Redis per async batch.",
  },

  // ── Mobile App ───────────────────────────────────────────────────
  {
    tab: "mobile",
    sort: 1,
    label: "Social photo app",
    prompt_seed:
      "App social tipo Instagram con React Native + Expo: feed scrollabile, upload foto con filtri base, like/comment, follow system, push notification (Expo notifications), backend Supabase.",
  },
  {
    tab: "mobile",
    sort: 2,
    label: "Habit tracker",
    prompt_seed:
      "App habit tracker minimalista con React Native: lista abitudini giornaliere, swipe per check, streak counter, statistiche settimanali (victory-native charts), reminder push, data locale in SQLite.",
  },
  {
    tab: "mobile",
    sort: 3,
    label: "Mobile e-commerce",
    prompt_seed:
      "App e-commerce mobile con React Native + Expo: catalogo prodotti, ricerca/filtri, cart, checkout con Stripe, ordini history, profile con address book, push notification per shipping update.",
  },
  {
    tab: "mobile",
    sort: 4,
    label: "Fitness tracker",
    prompt_seed:
      "App fitness con React Native + HealthKit/GoogleFit integration: tracking passi/distanza/calorie, workout logging (set/reps/weight), grafici progress, offline-first con sync background.",
  },
  {
    tab: "mobile",
    sort: 5,
    label: "Voice-note AI",
    prompt_seed:
      "App voice notes con AI transcription: registrazione audio (expo-av), upload backend per Whisper API transcription, summary auto con GPT, ricerca semantica con embeddings, condivisione link pubblico.",
  },
]

export function ensureBuilderSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS builder_template (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tab          TEXT NOT NULL,
      label        TEXT NOT NULL,
      prompt_seed  TEXT NOT NULL,
      sort         INTEGER NOT NULL DEFAULT 0,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS builder_template_tab_idx ON builder_template(tab, active, sort);
  `)

  // Seed if empty.
  const count = (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM builder_template").get()?.n ?? 0)
  if (count === 0) {
    const insert = db.prepare(
      "INSERT INTO builder_template (tab, label, prompt_seed, sort, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    )
    const now = Date.now()
    for (const t of SEED) insert.run(t.tab, t.label, t.prompt_seed, t.sort, now)
  }
}

export type BuilderTemplatesDeps = {
  licenseDb: Database
}

export function mountBuilderTemplatesRoutes(app: Hono, deps: BuilderTemplatesDeps) {
  ensureBuilderSchema(deps.licenseDb)
  const db = deps.licenseDb

  // ── GET /api/builder/templates?tab=<tab>&limit=<n> — PUBLIC ──────
  // Up to N random active chips for the requested tab. Random per
  // request so the modal feels fresh every time. Default 4.
  app.get("/api/builder/templates", (c) => {
    const tab = c.req.query("tab")
    if (!tab || !VALID_TABS.has(tab)) {
      return c.json({ error: "tab must be one of: " + Array.from(VALID_TABS).join(", ") }, 400)
    }
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "4", 10) || 4, 1), 12)
    const rows = db
      .query<
        { id: number; label: string; prompt_seed: string; sort: number },
        [string, number]
      >(
        // ORDER BY RANDOM() inside the active subset; sort is used only
        // for the all-list endpoint (curators expect deterministic order).
        `SELECT id, label, prompt_seed, sort
         FROM builder_template
         WHERE tab = ? AND active = 1
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(tab, limit)
    return c.json({ tab, templates: rows })
  })

  // ── GET /api/builder/templates/all — admin (basic-auth) ──────────
  // Full list for curation UI. Auth handled by the existing /admin
  // chain — caller already passed adminRouter middleware before this.
  // For simplicity we expose it under /api/admin/builder/templates so
  // it's behind the admin auth without re-implementing the check.
  app.get("/api/admin/builder/templates", (c) => {
    const rows = db
      .query<
        { id: number; tab: string; label: string; prompt_seed: string; sort: number; active: number; created_at: number },
        []
      >(
        "SELECT id, tab, label, prompt_seed, sort, active, created_at FROM builder_template ORDER BY tab, sort, id",
      )
      .all()
    return c.json({ templates: rows })
  })
}
