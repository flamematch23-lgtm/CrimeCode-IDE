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

export function userAuth(opts: UserAuthOpts): MiddlewareHandler {
  const cookieName = opts.cookieName ?? COOKIE_DEFAULT
  return async (c, next) => {
    const token = readCookie(c, cookieName)
    if (!token) return c.json({ error: "unauthorized" }, 401)

    // Crypto-only verification (HMAC + expiry), no DB lookup.
    const result = verifyTokenCrypto(token)
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401)

    // Cross-check session row in the provided DB: must exist + not be revoked.
    const session = opts.licenseDb
      .query("SELECT id, customer_id, revoked_at FROM auth_sessions WHERE id = ?")
      .get(result.payload.sid) as { id: string; customer_id: string; revoked_at: number | null } | null
    if (!session) return c.json({ error: "unauthorized", reason: "session_not_found" }, 401)
    if (session.revoked_at) return c.json({ error: "unauthorized", reason: "session_revoked" }, 401)

    const customer = opts.licenseDb
      .query("SELECT id, email, telegram, telegram_user_id, approval_status FROM customers WHERE id = ?")
      .get(session.customer_id) as Customer | null
    if (!customer) return c.json({ error: "unauthorized", reason: "customer_missing" }, 401)

    // Touch last_seen_at for liveness tracking.
    opts.licenseDb.run("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", Date.now(), session.id)

    c.set("customer", customer)
    c.set("sessionId", session.id)
    await next()
  }
}
