/**
 * Typed client per gli endpoint /community/* della cloud API (api.crimecode.cc).
 * Stesso pattern di account-client.ts: legge il Bearer token dalla web session,
 * chiama il cloud direttamente, ritorna null/throw quando non loggato.
 */
import { readWebSession } from "./teams-client"

export interface CommunityProfile {
  customer_id: string
  username: string | null
  avatar_seed: string
  bio: string | null
  created_at: number
  last_active: number
  rep_received: number
  events_total: number
  events_30d: number
}

export interface PublicCommunityProfile {
  username: string
  avatar_seed: string
  bio: string | null
  created_at: number
  last_active: number
  rep: number
  stats: {
    events_total: number
    events_30d: number
    score_total: number
    score_30d: number
  }
}

export interface LeaderboardEntry {
  rank: number
  username: string
  avatar_seed: string
  bio: string | null
  score: number
  events: number
  rep: number
  last_active: number
}

export interface Leaderboard {
  period: "30d" | "all"
  generated_at: number
  entries: LeaderboardEntry[]
}

export type CommunityEventType =
  | "session_created"
  | "message_sent"
  | "tool_call"
  | "burp_flow_captured"
  | "exploit_chain_built"
  | "report_generated"

const CLOUD_BASE = (() => {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
  const explicit = meta?.env?.VITE_LICENSE_API_URL ?? meta?.env?.VITE_API_URL
  if (explicit) return String(explicit).replace(/\/+$/, "")
  return "https://api.crimecode.cc"
})()

class NotSignedInError extends Error {
  constructor() {
    super("not signed in")
    this.name = "NotSignedInError"
  }
}

export function hasAccountSession(): boolean {
  return readWebSession() !== null
}

function bearer(): string {
  const s = readWebSession()
  if (!s) throw new NotSignedInError()
  return s.token
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer()}`,
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  if (init?.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json"
  return fetch(CLOUD_BASE + path, { ...init, headers })
}

async function publicFetch(path: string): Promise<Response> {
  return fetch(CLOUD_BASE + path)
}

// ─── Public endpoints ────────────────────────────────────────────────

export async function getLeaderboard(period: "30d" | "all" = "30d"): Promise<Leaderboard> {
  const res = await publicFetch(`/community/leaderboard?period=${period}`)
  if (!res.ok) throw new Error(`leaderboard ${res.status}`)
  return (await res.json()) as Leaderboard
}

export async function getPublicProfile(username: string): Promise<PublicCommunityProfile | null> {
  const res = await publicFetch(`/community/u/${encodeURIComponent(username)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`profile ${res.status}`)
  const body = (await res.json()) as { profile: PublicCommunityProfile }
  return body.profile
}

// ─── Authenticated endpoints ─────────────────────────────────────────

export async function getMyProfile(): Promise<CommunityProfile | null> {
  if (!hasAccountSession()) return null
  const res = await authedFetch("/community/me")
  if (!res.ok) {
    if (res.status === 401) return null
    throw new Error(`me ${res.status}`)
  }
  const body = (await res.json()) as { profile: CommunityProfile }
  return body.profile
}

export async function setUsername(username: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  if (!hasAccountSession()) return { ok: false, error: "not signed in" }
  const res = await authedFetch("/community/me/username", {
    method: "PUT",
    body: JSON.stringify({ username }),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; username?: string; error?: string }
  if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `error ${res.status}` }
  return { ok: true, username: body.username ?? username }
}

/**
 * Logga un evento attività dell'utente. Best-effort, non blocca la UI.
 * Rate limit lato server: 60 eventi/min/user.
 */
export async function logEvent(type: CommunityEventType, weight: number = 1): Promise<void> {
  if (!hasAccountSession()) return
  try {
    await authedFetch("/community/me/event", {
      method: "POST",
      body: JSON.stringify({ event_type: type, weight }),
    })
  } catch {
    // best-effort, no UI feedback
  }
}

// ─── Avatar generation (client-side) ─────────────────────────────────

/**
 * Genera URL avatar deterministico dal seed. Usa dicebear (gratuito, no auth).
 * Stesso seed → stesso avatar, sempre.
 */
export function avatarUrl(seed: string, size: number = 64): string {
  const safe = encodeURIComponent(seed)
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${safe}&size=${size}&backgroundType=gradientLinear`
}
