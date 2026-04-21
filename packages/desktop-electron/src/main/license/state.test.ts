import { describe, expect, test, setSystemTime, afterEach } from "bun:test"
import {
  TRIAL_DAYS,
  createEmptyLicense,
  applyStartTrial,
  applyActivate,
  applyAdminGrant,
  applyAdminRevoke,
  applyAdminExtendTrial,
  projectLicense,
  type LicenseRecord,
} from "./state"

afterEach(() => setSystemTime())

describe("license constants", () => {
  test("TRIAL_DAYS is exactly 2", () => {
    expect(TRIAL_DAYS).toBe(2)
  })
})

describe("createEmptyLicense", () => {
  test("starts with status=free, no trial consumed", () => {
    const record = createEmptyLicense()
    expect(record.status).toBe("free")
    expect(record.interval).toBeNull()
    expect(record.timeTrialEnd).toBeNull()
    expect(record.timeTrialConsumed).toBeNull()
    expect(record.licenseToken).toBeNull()
  })
})

describe("applyStartTrial", () => {
  test("from free: sets status=trial and timeTrialEnd = now + TRIAL_DAYS", () => {
    setSystemTime(new Date("2026-04-21T12:00:00Z"))
    const next = applyStartTrial(createEmptyLicense())
    expect(next.status).toBe("trial")
    expect(next.timeTrialEnd?.toISOString()).toBe("2026-04-23T12:00:00.000Z")
  })

  test("rejects if trial was already consumed", () => {
    const consumed: LicenseRecord = {
      ...createEmptyLicense(),
      timeTrialConsumed: new Date("2026-01-01T00:00:00Z"),
    }
    expect(() => applyStartTrial(consumed)).toThrow("Trial already used")
  })

  test("rejects if already active", () => {
    const active: LicenseRecord = {
      ...createEmptyLicense(),
      status: "active",
      interval: "monthly",
    }
    expect(() => applyStartTrial(active)).toThrow("Already subscribed")
  })
})

describe("applyActivate", () => {
  test("monthly: sets status=active with interval and token", () => {
    const next = applyActivate(createEmptyLicense(), {
      interval: "monthly",
      token: "tok_abc",
      issuedAt: new Date("2026-04-21T00:00:00Z"),
    })
    expect(next.status).toBe("active")
    expect(next.interval).toBe("monthly")
    expect(next.licenseToken).toBe("tok_abc")
  })

  test("lifetime: sets status=active and never expires", () => {
    const next = applyActivate(createEmptyLicense(), {
      interval: "lifetime",
      token: "tok_life",
      issuedAt: new Date("2026-04-21T00:00:00Z"),
    })
    expect(next.status).toBe("active")
    expect(next.interval).toBe("lifetime")
    expect(next.timeExpiry).toBeNull()
  })

  test("marks trial as consumed when activating during trial", () => {
    const trialing: LicenseRecord = {
      ...createEmptyLicense(),
      status: "trial",
      timeTrialEnd: new Date("2026-04-23T00:00:00Z"),
    }
    const next = applyActivate(trialing, {
      interval: "annual",
      token: "tok_yr",
      issuedAt: new Date("2026-04-22T00:00:00Z"),
    })
    expect(next.status).toBe("active")
    expect(next.timeTrialConsumed?.toISOString()).toBe("2026-04-22T00:00:00.000Z")
  })
})

describe("applyAdminGrant / applyAdminRevoke / applyAdminExtendTrial", () => {
  test("grant sets status=active, records grantedBy timestamp", () => {
    setSystemTime(new Date("2026-04-21T09:00:00Z"))
    const next = applyAdminGrant(createEmptyLicense(), { interval: "annual" })
    expect(next.status).toBe("active")
    expect(next.interval).toBe("annual")
    expect(next.issuedBy).toBe("admin")
    expect(next.timeIssued?.toISOString()).toBe("2026-04-21T09:00:00.000Z")
  })

  test("revoke returns to free but keeps timeTrialConsumed", () => {
    const record: LicenseRecord = {
      ...createEmptyLicense(),
      status: "active",
      interval: "monthly",
      timeTrialConsumed: new Date("2026-03-01T00:00:00Z"),
      licenseToken: "tok_x",
    }
    const next = applyAdminRevoke(record)
    expect(next.status).toBe("revoked")
    expect(next.interval).toBeNull()
    expect(next.licenseToken).toBeNull()
    expect(next.timeTrialConsumed?.toISOString()).toBe("2026-03-01T00:00:00.000Z")
  })

  test("extend-trial adds days to a trial already in progress", () => {
    const trialing: LicenseRecord = {
      ...createEmptyLicense(),
      status: "trial",
      timeTrialEnd: new Date("2026-04-23T12:00:00Z"),
    }
    const next = applyAdminExtendTrial(trialing, { days: 5 })
    expect(next.timeTrialEnd?.toISOString()).toBe("2026-04-28T12:00:00.000Z")
  })

  test("extend-trial on free record starts a fresh trial even after consumption", () => {
    setSystemTime(new Date("2026-05-01T00:00:00Z"))
    const consumed: LicenseRecord = {
      ...createEmptyLicense(),
      timeTrialConsumed: new Date("2026-04-01T00:00:00Z"),
    }
    const next = applyAdminExtendTrial(consumed, { days: 7 })
    expect(next.status).toBe("trial")
    expect(next.timeTrialEnd?.toISOString()).toBe("2026-05-08T00:00:00.000Z")
  })
})

describe("projectLicense (derives effective status for UI)", () => {
  test("trial that is still in window → effectiveStatus=trial", () => {
    setSystemTime(new Date("2026-04-22T00:00:00Z"))
    const record: LicenseRecord = {
      ...createEmptyLicense(),
      status: "trial",
      timeTrialEnd: new Date("2026-04-23T00:00:00Z"),
    }
    expect(projectLicense(record).effectiveStatus).toBe("trial")
  })

  test("trial that ended → effectiveStatus=trial_expired and trial marked consumed", () => {
    setSystemTime(new Date("2026-04-24T00:00:00Z"))
    const record: LicenseRecord = {
      ...createEmptyLicense(),
      status: "trial",
      timeTrialEnd: new Date("2026-04-23T00:00:00Z"),
    }
    const projected = projectLicense(record)
    expect(projected.effectiveStatus).toBe("trial_expired")
    expect(projected.timeTrialConsumed?.toISOString()).toBe("2026-04-23T00:00:00.000Z")
  })

  test("active lifetime is always effective", () => {
    const record: LicenseRecord = {
      ...createEmptyLicense(),
      status: "active",
      interval: "lifetime",
    }
    expect(projectLicense(record).effectiveStatus).toBe("active")
  })

  test("active monthly past timeExpiry → effectiveStatus=expired", () => {
    setSystemTime(new Date("2026-06-01T00:00:00Z"))
    const record: LicenseRecord = {
      ...createEmptyLicense(),
      status: "active",
      interval: "monthly",
      timeExpiry: new Date("2026-05-21T00:00:00Z"),
    }
    expect(projectLicense(record).effectiveStatus).toBe("expired")
  })
})
