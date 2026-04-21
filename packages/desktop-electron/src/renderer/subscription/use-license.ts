import { createResource, createSignal, onCleanup, onMount } from "solid-js"
import type { LicenseSnapshot } from "../../preload/types"

/**
 * Polls `window.api.license.get()` once on mount and every 60s afterwards.
 * Exposes a `refresh()` callback that components should call after any mutation
 * (e.g. start trial, admin grant) so UI updates immediately.
 */
export function useLicense() {
  const [refreshKey, setRefreshKey] = createSignal(0)
  const [license, { refetch }] = createResource(refreshKey, () => window.api.license.get())

  let interval: ReturnType<typeof setInterval> | null = null
  onMount(() => {
    interval = setInterval(() => setRefreshKey((k) => k + 1), 60_000)
  })
  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  return {
    license,
    refresh: () => {
      setRefreshKey((k) => k + 1)
      return refetch()
    },
  }
}

export const hasProAccess = (license: LicenseSnapshot | undefined): boolean => {
  if (!license) return false
  return license.effectiveStatus === "trial" || license.effectiveStatus === "active"
}
