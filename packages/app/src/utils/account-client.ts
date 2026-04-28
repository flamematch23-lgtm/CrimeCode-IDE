/**
 * Typed client for the customer dashboard endpoints (/account/* and /sync/me).
 *
 * IMPORTANT — these endpoints live on the CENTRAL API server (api.crimecode.cc)
 * because the customer record + cloud_event log live there, not on the local
 * Electron sidecar. Earlier versions of this module accepted whatever
 * `useServer().current` was set to, which on desktop after a Telegram login
 * is the local sidecar (Basic auth) — the local sidecar can't identify the
 * customer (`/account/me` requires a Bearer token verified against the
 * cloud's HMAC secret), so every call returned 401 and the Settings → Account
 * tab showed "not signed in" even when the user was clearly signed in.
 *
 * The client now reads the JWT from the web session (`readWebSession()`),
 * targets the cloud API directly, and returns null when the user isn't
 * signed in at all — no more conflating "no Bearer here" with "not signed in".
 */

import { readWebSession, writeWebSession } from "./teams-client"
import { notify } from "../context/notifications"

export interface AccountMe {
  customer_id: string
  telegram: string | null
  telegram_user_id: number | null
  email: string | null
  status: "pending" | "approved" | "rejected"
  created_at: number
  approved_at: number | null
  rejected_reason: string | null
}

export interface AccountDevice {
  id: string
  device_label: string | null
  created_at: number
  last_seen_at: number
  revoked_at: number | null
  active: boolean
}

export interface SyncMe {
  totalEvents: number
  uniqueAggregates: number
  firstPushedAt: number | null
  lastPushedAt: number | null
  topAggregates: Array<{
    aggregate_id: string
    eventCount: number
    lastPushedAt: number
  }>
}

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

/** True iff a Bearer token is present in localStorage. */
export function hasAccountSession(): boolean {
  return readWebSession() !== null
}

function bearer(): string {
  const s = readWebSession()
  if (!s) throw new NotSignedInError()
  return s.token
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(CLOUD_BASE + path, {
    headers: { Authorization: `Bearer ${bearer()}` },
  })
  if (res.status === 401) handleExpired()
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return (await res.json()) as T
}

/**
 * Centralised reaction to a cloud-side 401 — the JWT has expired or
 * been revoked. Wipe the local webSession so the auth-gate snaps the
 * user back to the sign-in screen, and post a notification so they
 * understand what happened (instead of just silently being logged out).
 */
let expiredHandled = false
function handleExpired(): void {
  if (expiredHandled) return
  expiredHandled = true
  writeWebSession(null)
  notify({
    level: "warning",
    title: "Session expired",
    body: "Your sign-in expired. Open the workspace switcher to sign in again.",
  })
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(CLOUD_BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer()}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) handleExpired()
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return (await res.json()) as T
}

async function deleteJSON<T>(path: string): Promise<T> {
  const res = await fetch(CLOUD_BASE + path, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearer()}` },
  })
  if (res.status === 401) handleExpired()
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return (await res.json()) as T
}

export function getAccountMe(): Promise<AccountMe> {
  return getJSON<AccountMe>("/account/me")
}

export function getAccountDevices(): Promise<{ devices: AccountDevice[] }> {
  return getJSON<{ devices: AccountDevice[] }>("/account/me/devices")
}

export function revokeDevice(sid: string): Promise<{ revoked: boolean }> {
  return deleteJSON<{ revoked: boolean }>(`/account/me/devices/${encodeURIComponent(sid)}`)
}

export function logoutAllDevices(): Promise<{ revoked: number }> {
  return postJSON<{ revoked: number }>("/account/me/devices/logout-all")
}

export function getSyncMe(): Promise<SyncMe> {
  return getJSON<SyncMe>("/sync/me")
}

export interface ReferralBonus {
  referrer: number
  referred: number
  monthlyCap: number
}

export interface ReferralClaim {
  referred_customer_id: string
  claimed_at: number
  referrer_bonus_days: number
}

export interface ReferralInfo {
  code: string
  shareUrl: string
  bonus: ReferralBonus
  eligibleToRedeem: boolean
  claims: ReferralClaim[]
}

export function getReferralInfo(): Promise<ReferralInfo> {
  return getJSON<ReferralInfo>("/account/me/referral")
}

/**
 * Apply a referral code post-signup. Server-side eligibility rules:
 *   - Caller signed up <24h ago.
 *   - Caller hasn't already redeemed a code.
 *   - Code exists, isn't your own, and the referrer hasn't hit the cap.
 * Returns the bonus days awarded to each side.
 */
export function redeemReferralCode(code: string): Promise<{
  ok: true
  referrer_bonus_days: number
  referred_bonus_days: number
}> {
  return postJSON("/account/me/redeem-referral", { code })
}

export interface SyncStatusSnapshot {
  configured: boolean
  lastPushAt: number | null
  lastPullAt: number | null
  lastError: string | null
  pushedCount: number
  pulledCount: number
}

/**
 * Read /sync/status from a server (typically the local sidecar). The
 * `configured` flag is the single source of truth for "should I show
 * the Re-link button"; if it's false the sidecar has no
 * {api, token} pair to push with and Sync-now will fail.
 */
export async function getSyncStatus(
  server: { url: string; username?: string; password?: string },
): Promise<SyncStatusSnapshot | null> {
  const auth =
    server.username === "bearer"
      ? `Bearer ${server.password ?? ""}`
      : `Basic ${
          typeof btoa === "function"
            ? btoa(`${server.username ?? "opencode"}:${server.password ?? ""}`)
            : Buffer.from(`${server.username ?? "opencode"}:${server.password ?? ""}`).toString("base64")
        }`
  try {
    const r = await fetch(`${server.url.replace(/\/+$/, "")}/sync/status`, {
      headers: { Authorization: auth },
    })
    if (!r.ok) return null
    return (await r.json()) as SyncStatusSnapshot
  } catch {
    return null
  }
}

/**
 * Trigger an immediate sync round-trip on the LOCAL sidecar's CloudClient
 * (not the cloud — it's the local that pushes/pulls). Falls through to
 * /sync/sync-now on whatever HTTP creds the caller hands us. The Account
 * dashboard routes this to the local sidecar credentials it already has,
 * because the cloud doesn't run a CloudClient.
 */
export function triggerSyncNow(
  server: { url: string; username?: string; password?: string },
): Promise<{ ok: boolean; pushed: number; pulled: number; error?: string }> {
  const auth =
    server.username === "bearer"
      ? `Bearer ${server.password ?? ""}`
      : `Basic ${
          typeof btoa === "function"
            ? btoa(`${server.username ?? "opencode"}:${server.password ?? ""}`)
            : Buffer.from(`${server.username ?? "opencode"}:${server.password ?? ""}`).toString("base64")
        }`
  return fetch(`${server.url.replace(/\/+$/, "")}/sync/sync-now`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`sync-now ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`)
      return r.json() as Promise<{ ok: boolean; pushed: number; pulled: number; error?: string }>
    })
}
