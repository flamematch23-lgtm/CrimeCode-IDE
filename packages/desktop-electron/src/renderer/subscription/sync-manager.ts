/**
 * Cross-device sync glue between the local Electron state (localStorage +
 * opencode sidecar `/global/project`) and the cloud KV store under
 * `/license/sync/{key}`.
 *
 * Keep the surface small on purpose: two snapshots (`client.settings` and
 * `client.recent-projects`), push-and-pull only, latest-wins. Anything more
 * ambitious (conflict resolution, CRDTs, encryption) is out of scope for
 * this pass.
 */

type RemoteEntry = { key: string; value: string; updated_at: number } | null

const SETTINGS_KEY = "client.settings"
const RECENTS_KEY = "client.recent-projects"
const LAST_SYNC_KEY = "client.last-sync-at"

const LOCAL_SETTINGS_KEY = "settings.v3"

interface RecentProject {
  worktree: string
  name?: string | null
  opened_at: number
}

async function readRemote(key: string): Promise<RemoteEntry> {
  try {
    return (await window.api.account.syncGet(key)) as RemoteEntry
  } catch {
    return null
  }
}

async function writeRemote(key: string, value: unknown): Promise<boolean> {
  try {
    await window.api.account.syncPut(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function readLocalSettings(): unknown | null {
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeLocalSettings(data: unknown): void {
  try {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(data))
  } catch {
    // quota or serialization errors — noop
  }
}

function readLocalRecents(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocalRecents(list: RecentProject[]): void {
  try {
    const dedup = new Map<string, RecentProject>()
    for (const p of list) {
      const prev = dedup.get(p.worktree)
      if (!prev || p.opened_at > prev.opened_at) dedup.set(p.worktree, p)
    }
    const sorted = [...dedup.values()].sort((a, b) => b.opened_at - a.opened_at).slice(0, 30)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(sorted))
  } catch {
    // noop
  }
}

export function recordProjectOpen(worktree: string, name?: string | null): void {
  const list = readLocalRecents()
  list.push({ worktree, name: name ?? null, opened_at: Math.floor(Date.now() / 1000) })
  writeLocalRecents(list)
}

export interface SyncResult {
  ok: boolean
  pushedSettings?: boolean
  pushedRecents?: boolean
  pulledSettings?: boolean
  pulledRecents?: number
  error?: string
}

export async function pushAll(): Promise<SyncResult> {
  try {
    const settings = readLocalSettings()
    const recents = readLocalRecents()
    const [pushedSettings, pushedRecents] = await Promise.all([
      settings ? writeRemote(SETTINGS_KEY, settings) : Promise.resolve(false),
      writeRemote(RECENTS_KEY, recents),
    ])
    localStorage.setItem(LAST_SYNC_KEY, String(Math.floor(Date.now() / 1000)))
    return { ok: true, pushedSettings, pushedRecents }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function pullAll(): Promise<SyncResult> {
  try {
    const [remoteSettings, remoteRecents] = await Promise.all([
      readRemote(SETTINGS_KEY),
      readRemote(RECENTS_KEY),
    ])
    let pulledSettings = false
    let pulledRecents = 0
    if (remoteSettings) {
      try {
        const parsed = JSON.parse(remoteSettings.value)
        writeLocalSettings(parsed)
        pulledSettings = true
      } catch {
        // remote payload was invalid JSON — leave local alone
      }
    }
    if (remoteRecents) {
      try {
        const parsed = JSON.parse(remoteRecents.value)
        if (Array.isArray(parsed)) {
          const merged = [...readLocalRecents(), ...(parsed as RecentProject[])]
          writeLocalRecents(merged)
          pulledRecents = (parsed as RecentProject[]).length
        }
      } catch {
        // noop
      }
    }
    localStorage.setItem(LAST_SYNC_KEY, String(Math.floor(Date.now() / 1000)))
    return { ok: true, pulledSettings, pulledRecents }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function lastSyncAt(): number | null {
  const raw = localStorage.getItem(LAST_SYNC_KEY)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Debounced push — good for wiring to settings changes. Bounces subsequent
 * calls within `delayMs` so we don't thrash the API.
 */
let pushTimer: ReturnType<typeof setTimeout> | null = null
export function schedulePush(delayMs = 5_000): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushAll()
  }, delayMs)
}
