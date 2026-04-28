/**
 * Renderer-side glue between a successful Telegram / account login and the
 * local Electron sidecar's cloud-sync client. Calling /sync/configure on
 * the sidecar tells it: here is the Bearer token, here is the cloud API
 * URL — start pushing local events to the cloud and pulling new ones on
 * a 60s timer.
 *
 * Also handles the *license auto-apply* on login: if the customer already
 * has an active license on the cloud (from a paid order, or from an
 * admin-granted trial), the desktop sidecar's local license cache gets
 * the activation token without the user having to copy-paste anything.
 *
 * On the web app there is no local sidecar; both calls are no-ops.
 *
 * Best-effort by design: never throws, never blocks the login UI. If the
 * configure call fails, the rest of the app continues to work via direct
 * cloud API calls — the user just doesn't get the desktop-side replication.
 */

import { buildAuthHeader } from "./auth-fetch"
import { notify } from "../context/notifications"

const CLOUD_API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "https://api.crimecode.cc"

interface SidecarInfo {
  url: string
  username: string
  password: string
}

/**
 * Resolve the local sidecar's URL + Basic-auth creds via the Electron
 * preload bridge. Returns null in the browser (web app) or if the bridge
 * isn't ready yet — both are normal, non-error conditions.
 */
async function getSidecarInfo(): Promise<SidecarInfo | null> {
  const api = (window as unknown as { api?: { awaitInitialization?: (cb: (s: unknown) => void) => Promise<SidecarInfo> } }).api
  if (!api?.awaitInitialization) return null
  try {
    return await api.awaitInitialization(() => {})
  } catch {
    return null
  }
}

/**
 * Hand the freshly-issued Bearer token to the local sidecar so its
 * CloudClient can configure itself. Caller does not need to await: this
 * function never throws, errors land on the console.
 */
export async function configureCloudSyncIfDesktop(bearerToken: string): Promise<void> {
  const sidecar = await getSidecarInfo()
  if (!sidecar) return

  const auth = buildAuthHeader({
    url: sidecar.url,
    username: sidecar.username,
    password: sidecar.password,
  })
  if (!auth) return

  const url = sidecar.url.replace(/\/+$/, "") + "/sync/configure"
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ api: CLOUD_API_URL, token: bearerToken }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.warn("[cloud-sync] /sync/configure rejected", { status: res.status, detail: detail.slice(0, 200) })
      notify({
        level: "warning",
        title: "Cloud sync not configured",
        body: `The local sidecar refused /sync/configure (HTTP ${res.status}). Sync is disabled until the next login.`,
      })
      return
    }
    console.info("[cloud-sync] sidecar configured for cloud sync", { api: CLOUD_API_URL })
    notify({
      level: "success",
      title: "Cloud sync ready",
      body: `Your sessions will now sync across devices.`,
    })
  } catch (err) {
    console.warn("[cloud-sync] /sync/configure error", err)
  }
}

/**
 * Check the cloud for the customer's active license + activation token,
 * and if one exists hand it to the local Electron license bridge so the
 * Subscription Gate flips from "free" to "active"/"trial" without the
 * user having to copy-paste a token. No-op on web (no local bridge) and
 * no-op when the customer doesn't yet have a paid/granted license.
 *
 * Symmetric to configureCloudSyncIfDesktop in spirit (login → side-effect
 * on the local sidecar), so we expose it from the same module the
 * auth-gate already imports — one extra fire-and-forget call per login.
 */
export async function applyCloudLicenseIfDesktop(bearerToken: string): Promise<void> {
  // Web build has no `window.api.license` — fast path out.
  const license = (window as unknown as { api?: { license?: { activateToken?: (i: { interval: string; token: string }) => Promise<unknown> } } }).api
    ?.license
  if (!license?.activateToken) return

  try {
    const res = await fetch(CLOUD_API_URL + "/account/me/license", {
      headers: { Authorization: `Bearer ${bearerToken}` },
    })
    if (!res.ok) {
      // 401 means the JWT was rejected — likely revoked / expired; let
      // the rest of the auth flow surface that. Anything else, just log.
      if (res.status !== 401) {
        console.warn("[license] /account/me/license rejected", { status: res.status })
      }
      return
    }
    const body = (await res.json()) as {
      license: { id: string; interval: string; issued_at: number; expires_at: number | null } | null
      token: string | null
    }
    if (!body.license || !body.token) {
      // Customer has no active paid/trial license on the cloud — leave
      // the local state alone (the user might still be inside a local
      // free-trial window).
      return
    }
    await license.activateToken({ interval: body.license.interval, token: body.token })
    console.info("[license] auto-applied cloud license", {
      id: body.license.id,
      interval: body.license.interval,
    })
    notify({
      level: "success",
      title: "License applied",
      body: `Your ${body.license.interval} license is active on this device.`,
      href: "/account",
    })
  } catch (err) {
    console.warn("[license] auto-apply error", err)
  }
}
