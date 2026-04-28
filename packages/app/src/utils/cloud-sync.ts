/**
 * Renderer-side glue between a successful Telegram / account login and the
 * local Electron sidecar's cloud-sync client. Calling /sync/configure on
 * the sidecar tells it: here is the Bearer token, here is the cloud API
 * URL — start pushing local events to the cloud and pulling new ones on
 * a 60s timer.
 *
 * On the web app there is no local sidecar; this is a no-op.
 *
 * Best-effort by design: never throws, never blocks the login UI. If the
 * configure call fails, the rest of the app continues to work via direct
 * cloud API calls — the user just doesn't get the desktop-side replication.
 */

import { buildAuthHeader } from "./auth-fetch"

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
      return
    }
    console.info("[cloud-sync] sidecar configured for cloud sync", { api: CLOUD_API_URL })
  } catch (err) {
    console.warn("[cloud-sync] /sync/configure error", err)
  }
}
