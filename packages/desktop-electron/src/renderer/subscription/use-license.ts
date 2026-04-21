import { createResource, createRoot, createSignal, onCleanup } from "solid-js"
import type { LicenseSnapshot } from "../../preload/types"

export type { LicenseSnapshot }

/**
 * Module-level singleton: one poller and one createResource shared by all
 * `useLicense()` callers. Components should call `refresh()` after any
 * mutation (start trial, admin grant, etc.) so the snapshot updates immediately.
 */
const shared = createRoot(() => {
  const [key, setKey] = createSignal(0)
  const [license] = createResource(key, () => window.api.license.get())
  const id = setInterval(() => setKey((k) => k + 1), 60_000)
  onCleanup(() => clearInterval(id))
  return {
    license,
    refresh: () => setKey((k) => k + 1),
  }
})

export function useLicense() {
  return shared
}

export const hasProAccess = (license: LicenseSnapshot | undefined): boolean => {
  if (!license) return false
  return license.effectiveStatus === "trial" || license.effectiveStatus === "active"
}
