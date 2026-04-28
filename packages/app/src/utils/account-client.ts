/**
 * Typed client for the customer dashboard endpoints (/account/* and /sync/me).
 *
 * Every call is scoped server-side to the verified Bearer token's customer_id,
 * so the renderer never has to pass a customer id explicitly — the
 * Authorization header is the identity.
 */

import { withAuthHeaders, type HttpCreds } from "./auth-fetch"

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

function url(server: HttpCreds, path: string): string {
  const base = (server.url ?? "").replace(/\/+$/, "")
  return base + path
}

async function getJSON<T>(server: HttpCreds, path: string): Promise<T> {
  const res = await fetch(url(server, path), withAuthHeaders(server))
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return (await res.json()) as T
}

async function postJSON<T>(server: HttpCreds, path: string, body?: unknown): Promise<T> {
  const init = withAuthHeaders(server, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  })
  const res = await fetch(url(server, path), init)
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return (await res.json()) as T
}

async function deleteJSON<T>(server: HttpCreds, path: string): Promise<T> {
  const init = withAuthHeaders(server, { method: "DELETE" })
  const res = await fetch(url(server, path), init)
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
  return (await res.json()) as T
}

export function getAccountMe(server: HttpCreds): Promise<AccountMe> {
  return getJSON<AccountMe>(server, "/account/me")
}

export function getAccountDevices(server: HttpCreds): Promise<{ devices: AccountDevice[] }> {
  return getJSON<{ devices: AccountDevice[] }>(server, "/account/me/devices")
}

export function revokeDevice(server: HttpCreds, sid: string): Promise<{ revoked: boolean }> {
  return deleteJSON<{ revoked: boolean }>(server, `/account/me/devices/${encodeURIComponent(sid)}`)
}

export function logoutAllDevices(server: HttpCreds): Promise<{ revoked: number }> {
  return postJSON<{ revoked: number }>(server, "/account/me/devices/logout-all")
}

export function getSyncMe(server: HttpCreds): Promise<SyncMe> {
  return getJSON<SyncMe>(server, "/sync/me")
}

/**
 * Trigger an immediate sync round-trip on the local sidecar (push pending +
 * pull new). Only meaningful in the desktop app where the CloudClient runs;
 * on the web app this hits api.crimecode.cc which has no local CloudClient
 * to drive — the call still succeeds (returning a "not configured" status)
 * but is effectively a no-op.
 */
export function triggerSyncNow(
  server: HttpCreds,
): Promise<{ ok: boolean; pushed: number; pulled: number; error?: string }> {
  return postJSON<{ ok: boolean; pushed: number; pulled: number; error?: string }>(server, "/sync/sync-now")
}
