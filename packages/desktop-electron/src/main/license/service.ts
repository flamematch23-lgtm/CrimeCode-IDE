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
    // Persist the projected trial-consumed timestamp so we only compute once.
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

  activateFromToken(payload: { interval: ProInterval; token: string }): LicenseSnapshot {
    const next = applyActivate(this.read(), { ...payload, issuedAt: new Date() })
    this.write(next)
    return toSnapshot(projectLicense(next))
  }

  /** Used ONLY by the admin module — re-exported for IPC wiring. */
  _mutate(apply: (record: LicenseRecord) => LicenseRecord): LicenseSnapshot {
    const next = apply(this.read())
    this.write(next)
    return toSnapshot(projectLicense(next))
  }
}

export const licenseService = new LicenseService()
