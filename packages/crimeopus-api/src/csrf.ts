import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * CSRF token = HMAC(secret, sessionId) truncated to 32 hex chars.
 * Bound to the session — a stolen token is useless without the matching cookie.
 */
export function makeCsrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("hex").slice(0, 32)
}

export function verifyCsrfToken(token: string, sessionId: string, secret: string): boolean {
  const expected = makeCsrfToken(sessionId, secret)
  if (token.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(expected, "utf8"))
}
