import type { Context, MiddlewareHandler } from "hono"
import type { Database } from "bun:sqlite"
import { verifyTokenCrypto } from "../license-auth.ts"

export type Customer = {
  id: string
  email: string | null
  telegram: string | null
  telegram_user_id: number | null
  approval_status: string | null
}

declare module "hono" {
  interface ContextVariableMap {
    customer: Customer
    sessionId: string
  }
}

export type UserAuthOpts = {
  licenseDb: Database
  /** Cookie name to read. Defaults to "crimeopus_session". */
  cookieName?: string
}

const COOKIE_DEFAULT = "crimeopus_session"

function readCookie(c: Context, name: string): string | null {
  const raw = c.req.header("Cookie")
  if (!raw) return null
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return rest.join("=")
  }
  return null
}

function readBearer(c: Context): string | null {
  const auth = c.req.header("Authorization") ?? c.req.header("authorization")
  if (!auth) return null
  const m = /^Bearer\s+(\S+)$/i.exec(auth)
  return m ? m[1] : null
}

export function userAuth(opts: UserAuthOpts): MiddlewareHandler {
  const cookieName = opts.cookieName ?? COOKIE_DEFAULT
  return async (c, next) => {
    // Accetta sia cookie (browser dashboard) che Authorization: Bearer
    // (Electron app + CLI). Stesso token HMAC, due transport diversi.
    // L'app desktop non può settare cookie cross-origin facilmente, quindi
    // senza Bearer support i nuovi endpoint /community/* erano inaccessibili
    // dall'app pur essendo l'utente loggato.
    const token = readCookie(c, cookieName) ?? readBearer(c)
    if (!token) return c.json({ error: "unauthorized" }, 401)

    // Crypto-only verification (HMAC + expiry), no DB lookup.
    const result = verifyTokenCrypto(token)
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401)

    // ── BUG-FIX (community 401 storm): JIT shadow session/customer ────
    //
    // Architettura dual-server: api.crimecode.cc (Fly.io OpenCode serve)
    // genera le session via Telegram login → row in licenseDb su Fly volume.
    // Ma ai.crimecode.cc (Hetzner crimeopus-api) ha una licenseDb LOCALE
    // separata. Quando l'utente chiama /community/* su Hetzner con il
    // suo Bearer token:
    //   - HMAC verifica OK (stessa LICENSE_HMAC_SECRET)
    //   - Lookup session_id su Hetzner DB → NOT FOUND → 401
    // Risultato: TUTTI gli endpoint auth (/community/me, /dm/inbox, etc.)
    // tornavano 401 per ogni utente loggato. Sintomo riportato dall'utente.
    //
    // Fix: trust-on-first-use. Se HMAC valida E session non esiste qui,
    // INSERT OR IGNORE customer + session locali usando il payload del
    // token come ground truth. La payload contiene `sub` (customer_id),
    // `tg` (telegram id), `sid` (session id). Niente PII oltre quello.
    // Sicurezza: HMAC è già la prova di identità — il check session
    // locale era ridondante per il cross-server scenario.
    const sessionRow = opts.licenseDb
      .query("SELECT id, customer_id, revoked_at FROM auth_sessions WHERE id = ?")
      .get(result.payload.sid) as { id: string; customer_id: string; revoked_at: number | null } | null

    if (sessionRow?.revoked_at) {
      // Se la session è stata esplicitamente revocata localmente, blocca.
      // (Il logout su Fly.io non si propaga qui, quindi la revoke "globale"
      // non funziona. Limitazione accettata per MVP.)
      return c.json({ error: "unauthorized", reason: "session_revoked" }, 401)
    }

    let customerId: string
    let sessionId: string

    if (sessionRow) {
      customerId = sessionRow.customer_id
      sessionId = sessionRow.id
    } else {
      // JIT shadow provisioning
      customerId = result.payload.sub
      sessionId = result.payload.sid
      const now = Date.now()
      try {
        opts.licenseDb.run(
          "INSERT OR IGNORE INTO customers (id, email, telegram, telegram_user_id, created_at, approval_status) VALUES (?, NULL, NULL, ?, ?, 'approved')",
          customerId,
          result.payload.tg ?? null,
          now,
        )
        opts.licenseDb.run(
          "INSERT OR IGNORE INTO auth_sessions (id, customer_id, device_label, created_at, last_seen_at) VALUES (?, ?, 'shadow', ?, ?)",
          sessionId,
          customerId,
          now,
          now,
        )
      } catch {
        // Race condition: another request inserted concurrently — that's
        // fine, INSERT OR IGNORE absorbs the conflict.
      }
    }

    const customer = opts.licenseDb
      .query("SELECT id, email, telegram, telegram_user_id, approval_status FROM customers WHERE id = ?")
      .get(customerId) as Customer | null
    if (!customer) {
      // Estremamente raro: shadow insert sopra dovrebbe averlo creato.
      return c.json({ error: "unauthorized", reason: "customer_provision_failed" }, 401)
    }

    // Touch last_seen_at for liveness tracking.
    opts.licenseDb.run("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", Date.now(), sessionId)

    c.set("customer", customer)
    c.set("sessionId", sessionId)
    await next()
  }
}
