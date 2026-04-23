import { getStore } from "../store"
import { LICENSE_KEY, LICENSE_STORE } from "../constants"
import {
  applyActivate,
  applyStartTrial,
  createEmptyLicense,
  projectLicense,
  type LicenseRecord,
  type ProInterval,
  type ProjectedLicense,
} from "./state"

/**
 * IPC transport shape: `Date` fields flattened to ISO strings so the renderer
 * receives predictable serializable values. Do NOT use this type internally —
 * for in-process code, use `ProjectedLicense` from `./state` (which carries
 * real `Date` objects).
 */
export interface LicenseSnapshot {
  status: LicenseRecord["status"]
  interval: LicenseRecord["interval"]
  timeTrialEnd: string | null
  timeTrialConsumed: string | null
  timeIssued: string | null
  timeExpiry: string | null
  licenseToken: string | null
  issuedBy: LicenseRecord["issuedBy"]
  effectiveStatus: LicenseRecord["status"]
  trialDaysRemaining: number | null
}

const VALID_STATUSES = new Set(["free", "trial", "trial_expired", "active", "expired", "revoked"])
export const VALID_INTERVALS = new Set(["monthly", "annual", "lifetime"])
const VALID_ISSUERS = new Set(["stripe", "admin"])

const readStatus = (raw: unknown): LicenseRecord["status"] =>
  typeof raw === "string" && VALID_STATUSES.has(raw) ? (raw as LicenseRecord["status"]) : "free"

const readInterval = (raw: unknown): LicenseRecord["interval"] =>
  typeof raw === "string" && VALID_INTERVALS.has(raw) ? (raw as LicenseRecord["interval"]) : null

const readIssuer = (raw: unknown): LicenseRecord["issuedBy"] =>
  typeof raw === "string" && VALID_ISSUERS.has(raw) ? (raw as LicenseRecord["issuedBy"]) : null

const reviveDates = (raw: unknown): LicenseRecord => {
  const base = createEmptyLicense()
  if (!raw || typeof raw !== "object") return base
  const record = raw as Record<string, unknown>
  const readDate = (key: string): Date | null => {
    const value = record[key]
    if (typeof value !== "string") return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return {
    status: readStatus(record.status),
    interval: readInterval(record.interval),
    timeTrialEnd: readDate("timeTrialEnd"),
    timeTrialConsumed: readDate("timeTrialConsumed"),
    timeIssued: readDate("timeIssued"),
    timeExpiry: readDate("timeExpiry"),
    licenseToken: typeof record.licenseToken === "string" ? record.licenseToken : null,
    issuedBy: readIssuer(record.issuedBy),
  }
}

const serializeDates = (record: LicenseRecord) => ({
  ...record,
  timeTrialEnd: record.timeTrialEnd?.toISOString() ?? null,
  timeTrialConsumed: record.timeTrialConsumed?.toISOString() ?? null,
  timeIssued: record.timeIssued?.toISOString() ?? null,
  timeExpiry: record.timeExpiry?.toISOString() ?? null,
})

const toSnapshot = (projected: ProjectedLicense): LicenseSnapshot => ({
  status: projected.status,
  interval: projected.interval,
  timeTrialEnd: projected.timeTrialEnd?.toISOString() ?? null,
  timeTrialConsumed: projected.timeTrialConsumed?.toISOString() ?? null,
  timeIssued: projected.timeIssued?.toISOString() ?? null,
  timeExpiry: projected.timeExpiry?.toISOString() ?? null,
  licenseToken: projected.licenseToken,
  issuedBy: projected.issuedBy,
  effectiveStatus: projected.effectiveStatus,
  trialDaysRemaining: projected.trialDaysRemaining,
})

const API_BASE_URL = process.env.OPENCODE_LICENSE_API_URL ?? "https://api.crimecode.cc"
const VALIDATE_TIMEOUT_MS = 10_000

interface RemoteValidate {
  status: "valid" | "expired" | "revoked" | "unknown"
  expires_at?: number | null
  interval?: ProInterval
  reason?: string
}

async function callValidate(token: string, machineId: string | null): Promise<RemoteValidate> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE_URL}/license/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, machine_id: machineId }),
      signal: ctrl.signal,
    })
    if (!res.ok) return { status: "unknown", reason: `http_${res.status}` }
    return (await res.json()) as RemoteValidate
  } finally {
    clearTimeout(timer)
  }
}

function getMachineId(): string | null {
  try {
    // electron is available because this file only runs in the main process.
    // Hash userData path + hostname for a stable per-install identifier without
    // requiring extra native deps.
    const { app } = require("electron") as typeof import("electron")
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    const { hostname } = require("node:os") as typeof import("node:os")
    const seed = `${hostname()}|${app.getPath("userData")}`
    return createHash("sha256").update(seed).digest("hex").slice(0, 24)
  } catch {
    return null
  }
}

export class LicenseService {
  private read(): LicenseRecord {
    const raw = getStore(LICENSE_STORE).get(LICENSE_KEY)
    return reviveDates(raw)
  }

  private write(record: LicenseRecord): void {
    getStore(LICENSE_STORE).set(LICENSE_KEY, serializeDates(record))
  }

  get(): LicenseSnapshot {
    const record = this.read()
    const projected = projectLicense(record)
    if (record.status === "trial" && projected.effectiveStatus === "trial_expired") {
      this.write({ ...record, status: "trial_expired", timeTrialConsumed: projected.timeTrialConsumed })
    }
    return toSnapshot(projected)
  }

  startTrial(): LicenseSnapshot {
    const next = applyStartTrial(this.read())
    this.write(next)
    return toSnapshot(projectLicense(next))
  }

  async activateFromToken(payload: { interval: ProInterval; token: string }): Promise<LicenseSnapshot> {
    const machineId = getMachineId()
    const remote = await callValidate(payload.token, machineId).catch(
      (err): RemoteValidate => ({ status: "unknown", reason: err instanceof Error ? err.message : String(err) }),
    )
    if (remote.status !== "valid") {
      const reason = remote.reason ?? remote.status
      throw new Error(`Token rejected by server: ${reason}`)
    }
    const interval = remote.interval ?? payload.interval
    const expiry = remote.expires_at ? new Date(remote.expires_at * 1000) : null
    const next = applyActivate(this.read(), {
      interval,
      token: payload.token,
      issuedAt: new Date(),
      expiry,
    })
    this.write(next)
    return toSnapshot(projectLicense(next))
  }

  /**
   * Re-check the license against the server. Called periodically and at app
   * start. If the server says "revoked" or "expired", we update the local
   * state. If the server is unreachable, we leave the cached state alone
   * (offline tolerance).
   */
  async refreshFromRemote(): Promise<LicenseSnapshot | null> {
    const record = this.read()
    if (record.status !== "active" || !record.licenseToken) return null
    const machineId = getMachineId()
    let remote: RemoteValidate
    try {
      remote = await callValidate(record.licenseToken, machineId)
    } catch {
      return toSnapshot(projectLicense(record))
    }
    if (remote.status === "valid") {
      const expiry = remote.expires_at ? new Date(remote.expires_at * 1000) : null
      const next: LicenseRecord = { ...record, timeExpiry: expiry }
      this.write(next)
      return toSnapshot(projectLicense(next))
    }
    if (remote.status === "revoked") {
      const next: LicenseRecord = { ...record, status: "revoked" }
      this.write(next)
      return toSnapshot(projectLicense(next))
    }
    if (remote.status === "expired") {
      const next: LicenseRecord = {
        ...record,
        timeExpiry: remote.expires_at ? new Date(remote.expires_at * 1000) : new Date(),
      }
      this.write(next)
      return toSnapshot(projectLicense(next))
    }
    // status === "unknown" → server doesn't recognize the token. Keep the
    // local cached state; next online check will retry.
    return toSnapshot(projectLicense(record))
  }

  /** Used ONLY by the admin module — re-exported for IPC wiring. */
  _mutate(apply: (record: LicenseRecord) => LicenseRecord): LicenseSnapshot {
    const next = apply(this.read())
    this.write(next)
    return toSnapshot(projectLicense(next))
  }
}

export const licenseService = new LicenseService()

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * Schedule a periodic license re-check (~7 days). Also triggers an immediate
 * check at startup. No-op if the user is not on an active license.
 */
export function scheduleLicenseRefresh(): void {
  if (refreshTimer) return
  void licenseService.refreshFromRemote().catch(() => undefined)
  refreshTimer = setInterval(() => {
    void licenseService.refreshFromRemote().catch(() => undefined)
  }, REFRESH_INTERVAL_MS)
}
