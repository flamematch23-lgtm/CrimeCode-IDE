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

const VALID_STATUSES = new Set(["free", "trial", "trial_expired", "active", "expired", "revoked"])
const VALID_INTERVALS = new Set(["monthly", "annual", "lifetime"])
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

export class LicenseService {
  private read(): LicenseRecord {
    const raw = getStore(LICENSE_STORE).get(LICENSE_KEY)
    return reviveDates(raw)
  }

  private write(record: LicenseRecord): void {
    getStore(LICENSE_STORE).set(LICENSE_KEY, serializeDates(record))
  }

  get(): ProjectedLicense {
    const record = this.read()
    const projected = projectLicense(record)
    // Persist the projected trial-consumed timestamp so we only compute once.
    if (record.status === "trial" && projected.effectiveStatus === "trial_expired") {
      this.write({ ...record, status: "trial_expired", timeTrialConsumed: projected.timeTrialConsumed })
    }
    return projected
  }

  startTrial(): ProjectedLicense {
    const next = applyStartTrial(this.read())
    this.write(next)
    return projectLicense(next)
  }

  activateFromToken(payload: { interval: ProInterval; token: string }): ProjectedLicense {
    const next = applyActivate(this.read(), { ...payload, issuedAt: new Date() })
    this.write(next)
    return projectLicense(next)
  }

  /** Used ONLY by the admin module — re-exported for IPC wiring. */
  _mutate(apply: (record: LicenseRecord) => LicenseRecord): ProjectedLicense {
    const next = apply(this.read())
    this.write(next)
    return projectLicense(next)
  }
}

export const licenseService = new LicenseService()
