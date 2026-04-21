import { createHash } from "node:crypto"
import { CHANNEL } from "../constants"
import { ADMIN_PASSPHRASE_SHA256 } from "../constants"
import { licenseService } from "./service"
import {
  applyAdminExtendTrial,
  applyAdminGrant,
  applyAdminRevoke,
  createEmptyLicense,
  type ProInterval,
  type ProjectedLicense,
} from "./state"

export const sha256Hex = async (input: string): Promise<string> =>
  createHash("sha256").update(input, "utf8").digest("hex")

export const passphraseMatches = async (input: string, expectedHex: string): Promise<boolean> => {
  if (!expectedHex) return false
  const actual = await sha256Hex(input)
  return actual.toLowerCase() === expectedHex.toLowerCase()
}

export class AdminSession {
  private unlocked = CHANNEL === "dev"
  isUnlocked(): boolean {
    return this.unlocked
  }
  async unlock(passphrase: string): Promise<boolean> {
    if (this.unlocked) return true
    const ok = await passphraseMatches(passphrase, ADMIN_PASSPHRASE_SHA256)
    if (ok) this.unlocked = true
    return ok
  }
  lock(): void {
    if (CHANNEL !== "dev") this.unlocked = false
  }
}
export const adminSession = new AdminSession()

const assertUnlocked = () => {
  if (!adminSession.isUnlocked()) throw new Error("Admin panel is locked")
}

export const adminGrant = (interval: ProInterval): ProjectedLicense => {
  assertUnlocked()
  return licenseService._mutate((r) => applyAdminGrant(r, { interval }))
}

export const adminRevoke = (): ProjectedLicense => {
  assertUnlocked()
  return licenseService._mutate(applyAdminRevoke)
}

export const adminExtendTrial = (days: number): ProjectedLicense => {
  assertUnlocked()
  return licenseService._mutate((r) => applyAdminExtendTrial(r, { days }))
}

export const adminReset = (): ProjectedLicense => {
  assertUnlocked()
  return licenseService._mutate(() => createEmptyLicense())
}
