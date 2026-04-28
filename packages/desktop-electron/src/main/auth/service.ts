import { app } from "electron"
import { hostname } from "node:os"
import { LICENSE_STORE } from "../constants"
import { getStore } from "../store"

const API_BASE_URL = process.env.OPENCODE_LICENSE_API_URL ?? "https://api.crimecode.cc"
const SESSION_KEY = "session"

export interface SessionState {
  token: string
  customer_id: string
  telegram_user_id: number | null
  expires_at: number
  signed_in_at: number
}

interface RawSession {
  token?: unknown
  customer_id?: unknown
  telegram_user_id?: unknown
  expires_at?: unknown
  signed_in_at?: unknown
}

function readSession(): SessionState | null {
  const raw = getStore(LICENSE_STORE).get(SESSION_KEY) as RawSession | undefined
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.token !== "string" || typeof raw.customer_id !== "string") return null
  if (typeof raw.expires_at !== "number") return null
  if (raw.expires_at <= Math.floor(Date.now() / 1000)) return null
  return {
    token: raw.token,
    customer_id: raw.customer_id,
    telegram_user_id: typeof raw.telegram_user_id === "number" ? raw.telegram_user_id : null,
    expires_at: raw.expires_at,
    signed_in_at: typeof raw.signed_in_at === "number" ? raw.signed_in_at : Math.floor(Date.now() / 1000),
  }
}

function writeSession(s: SessionState | null): void {
  if (s) getStore(LICENSE_STORE).set(SESSION_KEY, s)
  else getStore(LICENSE_STORE).delete(SESSION_KEY)
}

function deviceLabel(): string {
  return `${app.getName()} on ${hostname()}`
}

interface StartResponse {
  pin: string
  expires_at: number
  bot_url: string
}

interface PollResponse {
  status: "pending" | "ok" | "expired" | "unknown" | "awaiting_approval" | "rejected"
  token?: string
  exp?: number
  customer_id?: string
  rejected_reason?: string | null
}

/** Extended poll result passed to renderer. */
export interface PollResult {
  status: "ok" | "pending" | "expired" | "unknown" | "awaiting_approval" | "rejected"
  token?: string
  exp?: number
  customer_id?: string
  rejected_reason?: string | null
}

export class AuthService {
  get(): SessionState | null {
    return readSession()
  }

  isSignedIn(): boolean {
    return readSession() !== null
  }

  async startSignIn(): Promise<StartResponse> {
    const res = await fetch(`${API_BASE_URL}/license/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_label: deviceLabel() }),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      throw new Error(`auth/start failed: ${res.status} ${txt.slice(0, 200)}`)
    }
    return (await res.json()) as StartResponse
  }

  /** Single poll. Returns PollResult with extended status info. */
  async pollSignIn(pin: string): Promise<PollResult> {
    const res = await fetch(`${API_BASE_URL}/license/auth/poll/${encodeURIComponent(pin)}`)
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      throw new Error(`auth/poll failed: ${res.status} ${txt.slice(0, 200)}`)
    }
    const body = (await res.json()) as PollResponse
    if (body.status === "ok" && body.token && body.customer_id && body.exp) {
      const session: SessionState = {
        token: body.token,
        customer_id: body.customer_id,
        telegram_user_id: null,
        expires_at: body.exp,
        signed_in_at: Math.floor(Date.now() / 1000),
      }
      writeSession(session)
      return { status: "ok", token: body.token, exp: body.exp, customer_id: body.customer_id }
    }
    if (body.status === "awaiting_approval") {
      return { status: "awaiting_approval", customer_id: body.customer_id }
    }
    if (body.status === "rejected") {
      return { status: "rejected", customer_id: body.customer_id, rejected_reason: body.rejected_reason ?? null }
    }
    if (body.status === "expired" || body.status === "unknown") {
      throw new Error(`pin_${body.status}`)
    }
    return { status: "pending" }
  }

  async logout(): Promise<void> {
    const s = readSession()
    if (s) {
      try {
        await fetch(`${API_BASE_URL}/license/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.token}` },
        })
      } catch {
        // local clear is enough even if the server call fails
      }
    }
    writeSession(null)
  }

  /** Generic authenticated fetch helper used by sync. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const s = readSession()
    if (!s) throw new Error("not_signed_in")
    const headers = new Headers(init.headers ?? {})
    headers.set("Authorization", `Bearer ${s.token}`)
    return fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  }

  // ── Username / password auth ──────────────────────────────────────────

  async signUp(input: {
    username: string
    password: string
    telegram?: string
    email?: string
    /** Referral code from a /r/<CODE> link, optional. */
    referral_code?: string
  }): Promise<
    { status: "ok"; token: string; exp: number; customer_id: string } | { status: "pending"; customer_id: string }
  > {
    const res = await fetch(`${API_BASE_URL}/license/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        device_label: deviceLabel(),
      }),
    })
    const text = await res.text().catch(() => "")
    if (res.status === 202) {
      const body = JSON.parse(text)
      return { status: "pending" as const, customer_id: body.customer_id }
    }
    if (!res.ok) {
      try {
        const body = JSON.parse(text)
        throw new Error(body.error ?? `signup failed: ${res.status}`)
      } catch (e: any) {
        throw new Error(e.message ?? `signup failed: ${res.status}`)
      }
    }
    const body = JSON.parse(text)
    return { status: "ok" as const, token: body.token, exp: body.exp, customer_id: body.customer_id }
  }

  async signIn(input: {
    username: string
    password: string
  }): Promise<
    { status: "ok"; token: string; exp: number; customer_id: string } | { status: "pending"; customer_id: string }
  > {
    const res = await fetch(`${API_BASE_URL}/license/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        device_label: deviceLabel(),
      }),
    })
    const text = await res.text().catch(() => "")
    if (res.status === 202) {
      const body = JSON.parse(text)
      return { status: "pending" as const, customer_id: body.customer_id }
    }
    if (!res.ok) {
      try {
        const body = JSON.parse(text)
        throw new Error(body.error ?? `signin failed: ${res.status}`)
      } catch (e: any) {
        throw new Error(e.message ?? `signin failed: ${res.status}`)
      }
    }
    const body = JSON.parse(text)
    return { status: "ok" as const, token: body.token, exp: body.exp, customer_id: body.customer_id }
  }

  async approvalStatus(
    customerId: string,
  ): Promise<{ status: "pending" | "approved" | "rejected"; rejected_reason?: string | null }> {
    const res = await fetch(`${API_BASE_URL}/license/auth/status/${encodeURIComponent(customerId)}`)
    const text = await res.text().catch(() => "")
    if (!res.ok) {
      const body = JSON.parse(text)
      throw new Error(body.error ?? `status failed: ${res.status}`)
    }
    return JSON.parse(text)
  }

  /** Store a session from username/password auth and write to disk. */
  writeSessionFromAuth(token: string, customerId: string, expiresAt: number): SessionState {
    const session: SessionState = {
      token,
      customer_id: customerId,
      telegram_user_id: null,
      expires_at: expiresAt,
      signed_in_at: Math.floor(Date.now() / 1000),
    }
    writeSession(session)
    return session
  }
}

export const authService = new AuthService()
