export const TRIAL_DAYS = 2

export type ProInterval = "monthly" | "annual" | "lifetime"
export type LicenseStatus = "free" | "trial" | "trial_expired" | "active" | "expired" | "revoked"

export interface LicenseRecord {
  status: LicenseStatus
  interval: ProInterval | null
  timeTrialEnd: Date | null
  timeTrialConsumed: Date | null
  timeIssued: Date | null
  timeExpiry: Date | null
  licenseToken: string | null
  issuedBy: "stripe" | "admin" | null
}

/**
 * In-process projection of a `LicenseRecord` with derived `effectiveStatus` and
 * `trialDaysRemaining` fields. Uses real `Date` objects — this is NOT the wire
 * shape. See `LicenseSnapshot` in `./service` for the IPC transport shape.
 */
export interface ProjectedLicense extends LicenseRecord {
  effectiveStatus: LicenseStatus
  trialDaysRemaining: number | null
}

const addDaysUTC = (date: Date, days: number) => {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export const createEmptyLicense = (): LicenseRecord => ({
  status: "free",
  interval: null,
  timeTrialEnd: null,
  timeTrialConsumed: null,
  timeIssued: null,
  timeExpiry: null,
  licenseToken: null,
  issuedBy: null,
})

export const applyStartTrial = (record: LicenseRecord): LicenseRecord => {
  if (record.status === "active") throw new Error("Already subscribed")
  if (record.timeTrialConsumed) throw new Error("Trial already used")
  const now = new Date()
  return {
    ...record,
    status: "trial",
    timeTrialEnd: addDaysUTC(now, TRIAL_DAYS),
  }
}

export const applyActivate = (
  record: LicenseRecord,
  payload: { interval: ProInterval; token: string; issuedAt: Date },
): LicenseRecord => ({
  ...record,
  status: "active",
  interval: payload.interval,
  licenseToken: payload.token,
  issuedBy: "stripe",
  timeIssued: payload.issuedAt,
  timeExpiry: null,
  timeTrialConsumed: record.status === "trial" ? payload.issuedAt : record.timeTrialConsumed,
})

export const applyAdminGrant = (
  record: LicenseRecord,
  payload: { interval: ProInterval },
): LicenseRecord => {
  const now = new Date()
  return {
    ...record,
    status: "active",
    interval: payload.interval,
    issuedBy: "admin",
    timeIssued: now,
    timeExpiry: null,
    licenseToken: null,
  }
}

export const applyAdminRevoke = (record: LicenseRecord): LicenseRecord => ({
  ...record,
  status: "revoked",
  interval: null,
  licenseToken: null,
  issuedBy: null,
  timeIssued: null,
  timeExpiry: null,
})

export const applyAdminExtendTrial = (
  record: LicenseRecord,
  payload: { days: number },
): LicenseRecord => {
  if (record.status === "trial" && record.timeTrialEnd) {
    return { ...record, timeTrialEnd: addDaysUTC(record.timeTrialEnd, payload.days) }
  }
  const now = new Date()
  return {
    ...record,
    status: "trial",
    timeTrialEnd: addDaysUTC(now, payload.days),
  }
}

export const projectLicense = (record: LicenseRecord): ProjectedLicense => {
  const now = Date.now()
  if (record.status === "trial" && record.timeTrialEnd) {
    if (record.timeTrialEnd.getTime() > now) {
      const msRemaining = record.timeTrialEnd.getTime() - now
      return {
        ...record,
        effectiveStatus: "trial",
        trialDaysRemaining: Math.ceil(msRemaining / (24 * 3600 * 1000)),
      }
    }
    return {
      ...record,
      effectiveStatus: "trial_expired",
      timeTrialConsumed: record.timeTrialConsumed ?? record.timeTrialEnd,
      trialDaysRemaining: 0,
    }
  }
  if (record.status === "active" && record.timeExpiry && record.timeExpiry.getTime() < now) {
    return { ...record, effectiveStatus: "expired", trialDaysRemaining: null }
  }
  return { ...record, effectiveStatus: record.status, trialDaysRemaining: null }
}
