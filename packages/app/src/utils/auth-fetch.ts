/**
 * Shared fetch helpers that attach the right Authorization header for the
 * active server connection. Needed by endpoints that don't flow through
 * the typed SDK client (e.g. `/liveshare/*`, `/security/*`).
 *
 * The backend switched to requiring auth on these routes in v2.13.0 —
 * without these helpers, every direct `fetch` gets a 401 Unauthorized.
 */

export interface HttpCreds {
  url?: string | null
  username?: string | null
  password?: string | null
}

export function buildAuthHeader(http: HttpCreds | null | undefined): string | null {
  if (!http || !http.password) return null
  // Bearer session = Telegram / username-password login. The token lives
  // in `password` and the marker username is literally "bearer".
  if (http.username === "bearer") return `Bearer ${http.password}`
  // Legacy Self-hosted basic auth.
  // Use proper base64 encoding that works in both browser and Node.js
  const credentials = `${http.username ?? "opencode"}:${http.password}`
  let encoded: string
  if (typeof btoa === "function") {
    encoded = btoa(credentials)
  } else {
    encoded = Buffer.from(credentials).toString("base64")
  }
  return `Basic ${encoded}`
}

export function withAuthHeaders(http: HttpCreds | null | undefined, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has("Authorization")) {
    const auth = buildAuthHeader(http)
    if (auth) headers.set("Authorization", auth)
  }
  return { ...init, headers }
}
