/**
 * Community Uploads — avatar + custom badges (Phase 4 partial)
 *
 * Storage:
 *   - File salvati su disco locale del VPS in /opt/crimeopus-api/uploads/{type}/
 *     (configurabile via UPLOAD_DIR env)
 *   - URL pubblico: https://ai.crimecode.cc/community/uploads/{type}/{filename}
 *   - Hono handler GET serve file con Content-Type appropriato
 *
 * Validation:
 *   - Solo image/png, image/jpeg, image/webp (Content-Type + magic bytes check)
 *   - Max 1 MB file size (avatar) / 200 KB (badge — più piccoli)
 *   - Filename sanitizzato: usa hash del customer_id + timestamp
 *
 * Schema:
 *   - community_user.avatar_url: opzionale, override su avatar_seed (dicebear)
 *   - community_custom_badge: badge personalizzati uploadati dall'utente,
 *     con flag approved_at (NULL = pending moderation)
 *
 * Endpoints:
 *   POST   /community/uploads/avatar       [auth] multipart upload
 *   DELETE /community/uploads/avatar       [auth] rimuovi avatar custom (torna a seed)
 *   POST   /community/uploads/badge        [auth] upload nuovo badge custom
 *   GET    /community/uploads/badges       [auth] lista miei badge custom
 *   DELETE /community/uploads/badges/:id   [auth] rimuovi badge custom
 *   GET    /community/uploads/{type}/{filename}   [public] serve file
 */
import type { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { mkdirSync, existsSync, writeFileSync, unlinkSync, statSync, readFileSync } from "node:fs"
import { join, basename, extname } from "node:path"
import { createHash } from "node:crypto"
import { userAuth } from "../middleware/user-auth.ts"

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/crimeopus-api/uploads"
const MAX_AVATAR_BYTES = 1_024 * 1_024 // 1 MB
const MAX_BADGE_BYTES = 200 * 1_024 // 200 KB
const MAX_BADGES_PER_USER = 5

const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"])
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
}

const UPLOADS_SCHEMA = `
ALTER TABLE community_user ADD COLUMN avatar_url TEXT;
CREATE TABLE IF NOT EXISTS community_custom_badge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  label       TEXT NOT NULL,
  image_url   TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  approved_at INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS custom_badge_customer_idx ON community_custom_badge(customer_id);
`

export function ensureUploadsSchema(db: Database) {
  // avatar_url ALTER may fail if column exists — wrap in try
  try {
    db.exec("ALTER TABLE community_user ADD COLUMN avatar_url TEXT")
  } catch {
    /* already exists */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_custom_badge (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      label       TEXT NOT NULL,
      image_url   TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      approved_at INTEGER,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE INDEX IF NOT EXISTS custom_badge_customer_idx ON community_custom_badge(customer_id);
  `)
}

function ensureUploadDir(subdir: string): string {
  const dir = join(UPLOAD_DIR, subdir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Magic bytes check: PNG = 89 50 4E 47, JPEG = FF D8 FF, WEBP = 52 49 46 46 ... 57 45 42 50 */
function detectImageMime(buf: Uint8Array): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp"
  return null
}

function makeFilename(customerId: string, mime: string): string {
  const hash = createHash("sha256").update(customerId).digest("hex").slice(0, 16)
  const ts = Date.now().toString(36)
  return `${hash}-${ts}${EXT_BY_MIME[mime] ?? ".bin"}`
}

export type CommunityUploadsDeps = {
  licenseDb: Database
}

export function mountCommunityUploadsRoutes(app: Hono, deps: CommunityUploadsDeps) {
  ensureUploadsSchema(deps.licenseDb)
  ensureUploadDir("avatars")
  ensureUploadDir("badges")
  const auth = userAuth({ licenseDb: deps.licenseDb })
  const db = deps.licenseDb

  // ── POST /community/uploads/avatar ─────────────────────────────────
  app.post("/community/uploads/avatar", auth, async (c) => {
    const me = c.var.customer.id
    const myUsername = db
      .query<{ username: string | null }, [string]>(
        "SELECT username FROM community_user WHERE customer_id = ?",
      )
      .get(me)
    if (!myUsername?.username) {
      return c.json({ error: "Imposta prima un username pubblico" }, 403)
    }

    const formData = await c.req.formData().catch(() => null)
    const file = formData?.get("file")
    if (!file || !(file instanceof File)) {
      return c.json({ error: "campo 'file' mancante (multipart/form-data)" }, 400)
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return c.json({ error: `max ${MAX_AVATAR_BYTES / 1024} KB (hai ${Math.round(file.size / 1024)} KB)` }, 400)
    }
    const declaredMime = file.type
    if (!ALLOWED_MIMES.has(declaredMime)) {
      return c.json({ error: `tipo non valido: ${declaredMime}. Solo PNG/JPEG/WEBP.` }, 400)
    }

    const buf = new Uint8Array(await file.arrayBuffer())
    const realMime = detectImageMime(buf)
    if (!realMime || !ALLOWED_MIMES.has(realMime)) {
      return c.json({ error: "il file non è un'immagine valida (magic bytes mismatch)" }, 400)
    }

    const filename = makeFilename(me, realMime)
    const target = join(UPLOAD_DIR, "avatars", filename)
    try {
      writeFileSync(target, buf)
    } catch (e) {
      return c.json({ error: `salvataggio fallito: ${(e as Error).message}` }, 500)
    }

    const publicUrl = `https://ai.crimecode.cc/community/uploads/avatars/${filename}`

    // Cancella l'avatar precedente se esisteva
    const prev = db
      .query<{ avatar_url: string | null }, [string]>(
        "SELECT avatar_url FROM community_user WHERE customer_id = ?",
      )
      .get(me)
    if (prev?.avatar_url) {
      const prevName = basename(prev.avatar_url)
      const prevPath = join(UPLOAD_DIR, "avatars", prevName)
      try {
        if (existsSync(prevPath) && prevName !== filename) unlinkSync(prevPath)
      } catch {
        /* ignore */
      }
    }

    db.prepare("UPDATE community_user SET avatar_url = ? WHERE customer_id = ?").run(publicUrl, me)
    return c.json({ ok: true, avatar_url: publicUrl })
  })

  // ── DELETE /community/uploads/avatar (revert a seed) ───────────────
  app.delete("/community/uploads/avatar", auth, (c) => {
    const me = c.var.customer.id
    const prev = db
      .query<{ avatar_url: string | null }, [string]>(
        "SELECT avatar_url FROM community_user WHERE customer_id = ?",
      )
      .get(me)
    if (prev?.avatar_url) {
      const prevName = basename(prev.avatar_url)
      const prevPath = join(UPLOAD_DIR, "avatars", prevName)
      try {
        if (existsSync(prevPath)) unlinkSync(prevPath)
      } catch {
        /* ignore */
      }
    }
    db.prepare("UPDATE community_user SET avatar_url = NULL WHERE customer_id = ?").run(me)
    return c.json({ ok: true })
  })

  // ── POST /community/uploads/badge ──────────────────────────────────
  app.post("/community/uploads/badge", auth, async (c) => {
    const me = c.var.customer.id

    const existing = (db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM community_custom_badge WHERE customer_id = ?",
      )
      .get(me)?.n ?? 0)
    if (existing >= MAX_BADGES_PER_USER) {
      return c.json({ error: `Max ${MAX_BADGES_PER_USER} badge custom per utente` }, 429)
    }

    const formData = await c.req.formData().catch(() => null)
    const file = formData?.get("file")
    const labelRaw = formData?.get("label")
    const descRaw = formData?.get("description")
    const label = typeof labelRaw === "string" ? labelRaw.trim().slice(0, 40) : ""
    const description = typeof descRaw === "string" ? descRaw.trim().slice(0, 200) : ""

    if (!label) return c.json({ error: "campo 'label' obbligatorio (max 40 char)" }, 400)
    if (!file || !(file instanceof File)) {
      return c.json({ error: "campo 'file' mancante" }, 400)
    }
    if (file.size > MAX_BADGE_BYTES) {
      return c.json({ error: `max ${MAX_BADGE_BYTES / 1024} KB` }, 400)
    }
    const declaredMime = file.type
    if (!ALLOWED_MIMES.has(declaredMime)) {
      return c.json({ error: `tipo non valido: ${declaredMime}` }, 400)
    }

    const buf = new Uint8Array(await file.arrayBuffer())
    const realMime = detectImageMime(buf)
    if (!realMime || !ALLOWED_MIMES.has(realMime)) {
      return c.json({ error: "non è un'immagine valida" }, 400)
    }

    const filename = makeFilename(me, realMime)
    const target = join(UPLOAD_DIR, "badges", filename)
    try {
      writeFileSync(target, buf)
    } catch (e) {
      return c.json({ error: `salvataggio fallito: ${(e as Error).message}` }, 500)
    }

    const publicUrl = `https://ai.crimecode.cc/community/uploads/badges/${filename}`
    const now = Date.now()
    // Auto-approve per ora (no moderation queue in v1). approved_at = now.
    // In Phase 5 si potrebbe aggiungere admin queue settando NULL e
    // visibile solo a chi lo ha creato finché non approvato.
    const result = db
      .prepare(
        "INSERT INTO community_custom_badge (customer_id, label, image_url, description, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(me, label, publicUrl, description || null, now, now)

    return c.json({
      ok: true,
      badge: {
        id: Number(result.lastInsertRowid),
        label,
        image_url: publicUrl,
        description: description || null,
      },
    })
  })

  // ── GET /community/uploads/badges (i miei) ─────────────────────────
  app.get("/community/uploads/badges", auth, (c) => {
    const me = c.var.customer.id
    const rows = db
      .query<
        {
          id: number
          label: string
          image_url: string
          description: string | null
          created_at: number
          approved_at: number | null
        },
        [string]
      >(
        "SELECT id, label, image_url, description, created_at, approved_at FROM community_custom_badge WHERE customer_id = ? ORDER BY created_at DESC",
      )
      .all(me)
    return c.json({ badges: rows })
  })

  // ── DELETE /community/uploads/badges/:id ────────────────────────────
  app.delete("/community/uploads/badges/:id", auth, (c) => {
    const me = c.var.customer.id
    const id = parseInt(c.req.param("id"), 10)
    if (!Number.isFinite(id)) return c.json({ error: "id invalido" }, 400)
    const row = db
      .query<{ image_url: string; customer_id: string }, [number]>(
        "SELECT image_url, customer_id FROM community_custom_badge WHERE id = ?",
      )
      .get(id)
    if (!row) return c.json({ error: "non trovato" }, 404)
    if (row.customer_id !== me) return c.json({ error: "non autorizzato" }, 403)

    const filename = basename(row.image_url)
    const target = join(UPLOAD_DIR, "badges", filename)
    try {
      if (existsSync(target)) unlinkSync(target)
    } catch {
      /* ignore */
    }
    db.prepare("DELETE FROM community_custom_badge WHERE id = ?").run(id)
    return c.json({ ok: true })
  })

  // ── GET /community/uploads/{type}/{filename} (public serve) ────────
  // Validation: filename whitelist solo [a-z0-9-]+\.(png|jpg|jpeg|webp)
  // NO path traversal (no ../).
  app.get("/community/uploads/:type/:filename", (c) => {
    const type = c.req.param("type")
    const filename = c.req.param("filename")
    if (!["avatars", "badges"].includes(type)) return c.json({ error: "type invalido" }, 400)
    if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(filename)) {
      return c.json({ error: "filename invalido" }, 400)
    }
    const path = join(UPLOAD_DIR, type, filename)
    if (!existsSync(path)) return c.json({ error: "non trovato" }, 404)
    try {
      const stat = statSync(path)
      const buf = readFileSync(path)
      const ext = extname(filename).toLowerCase()
      const ct =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : "image/jpeg"
      c.header("Content-Type", ct)
      c.header("Content-Length", String(stat.size))
      c.header("Cache-Control", "public, max-age=86400")
      c.header("Access-Control-Allow-Origin", "*")
      return c.body(new Uint8Array(buf) as any)
    } catch (e) {
      return c.json({ error: `read failed: ${(e as Error).message}` }, 500)
    }
  })
}
