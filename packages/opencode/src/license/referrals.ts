import { randomBytes } from "node:crypto"
import { getDb } from "./db"
import { Log } from "../util/log"

const log = Log.create({ service: "referrals" })

const REFERRER_BONUS_DAYS = 7 // referrer gets +7 days of trial
const REFERRED_BONUS_DAYS = 3 // new signup gets +3 days
const MAX_REFERRER_BONUS_PER_MONTH = 30 // cap so power-referrers can't farm forever

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // unambiguous base32 (no 0/O/1/I)

function newCode(): string {
  const bytes = randomBytes(8)
  let out = ""
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

export interface ReferralCodeRow {
  code: string
  customer_id: string
  created_at: number
}

export interface ReferralClaimRow {
  id: number
  code: string
  referrer_customer_id: string
  referred_customer_id: string
  claimed_at: number
  referrer_bonus_days: number
  referred_bonus_days: number
}

/**
 * Find or create the referral code for a customer. Each customer gets
 * exactly one stable code — re-calling returns the same code so a
 * shared link doesn't decay.
 */
export function getOrCreateReferralCode(customerId: string): ReferralCodeRow {
  const db = getDb()
  const existing = db
    .prepare<ReferralCodeRow, [string]>("SELECT * FROM referral_codes WHERE customer_id = ? LIMIT 1")
    .get(customerId)
  if (existing) return existing
  const now = Math.floor(Date.now() / 1000)
  // Avoid (rare) collision by retrying. The alphabet has 32^8 ≈ 1.1e12
  // values so a few thousand customers won't trip; still, be defensive.
  for (let i = 0; i < 10; i++) {
    const code = newCode()
    try {
      db.prepare("INSERT INTO referral_codes (code, customer_id, created_at) VALUES (?, ?, ?)").run(
        code,
        customerId,
        now,
      )
      return { code, customer_id: customerId, created_at: now }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("UNIQUE")) continue
      throw err
    }
  }
  throw new Error("could not generate a unique referral code after 10 attempts")
}

/** Resolve a code to its owner's customer_id, or null if invalid. */
export function resolveReferralCode(code: string): { customer_id: string } | null {
  const row = getDb()
    .prepare<{ customer_id: string }, [string]>(
      "SELECT customer_id FROM referral_codes WHERE code = ? LIMIT 1",
    )
    .get(code.toUpperCase())
  return row ?? null
}

export interface ClaimResult {
  ok: true
  referrer_customer_id: string
  referrer_bonus_days: number
  referred_bonus_days: number
}
export interface ClaimError {
  ok: false
  reason: "unknown_code" | "self_referral" | "already_claimed" | "monthly_cap"
}

/**
 * Record a referral claim when a brand-new signup mentions a code.
 * Idempotent on (referrer, referred): a second call for the same pair
 * returns `already_claimed`. Hits a monthly cap on the referrer side so
 * a viral campaign can't unlock 365 free days.
 */
export function claimReferral(opts: {
  code: string
  referredCustomerId: string
}): ClaimResult | ClaimError {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const owner = resolveReferralCode(opts.code)
  if (!owner) return { ok: false, reason: "unknown_code" }
  if (owner.customer_id === opts.referredCustomerId) {
    return { ok: false, reason: "self_referral" }
  }

  // Cap: total referrer_bonus_days awarded in the last 30 days.
  const monthAgo = now - 30 * 86400
  const recent = db
    .prepare<{ total: number }, [string, number]>(
      `SELECT COALESCE(SUM(referrer_bonus_days), 0) AS total
         FROM referral_claims
        WHERE referrer_customer_id = ? AND claimed_at > ?`,
    )
    .get(owner.customer_id, monthAgo)
  if ((recent?.total ?? 0) >= MAX_REFERRER_BONUS_PER_MONTH) {
    log.info("referral cap reached", { referrer: owner.customer_id, total: recent?.total })
    return { ok: false, reason: "monthly_cap" }
  }

  try {
    db.prepare(
      `INSERT INTO referral_claims
       (code, referrer_customer_id, referred_customer_id, claimed_at,
        referrer_bonus_days, referred_bonus_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.code.toUpperCase(),
      owner.customer_id,
      opts.referredCustomerId,
      now,
      REFERRER_BONUS_DAYS,
      REFERRED_BONUS_DAYS,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("UNIQUE")) return { ok: false, reason: "already_claimed" }
    throw err
  }

  log.info("referral claimed", {
    referrer: owner.customer_id,
    referred: opts.referredCustomerId,
    bonus: { referrer: REFERRER_BONUS_DAYS, referred: REFERRED_BONUS_DAYS },
  })
  return {
    ok: true,
    referrer_customer_id: owner.customer_id,
    referrer_bonus_days: REFERRER_BONUS_DAYS,
    referred_bonus_days: REFERRED_BONUS_DAYS,
  }
}

/** Claims where this customer is the referrer (newest first). */
export function listReferralsByCustomer(customerId: string, limit = 50): ReferralClaimRow[] {
  return getDb()
    .prepare<ReferralClaimRow, [string, number]>(
      "SELECT * FROM referral_claims WHERE referrer_customer_id = ? ORDER BY claimed_at DESC LIMIT ?",
    )
    .all(customerId, limit)
}

/** Constants exposed so the bot's reply text matches the actual award. */
export const REFERRAL_BONUS = {
  referrer: REFERRER_BONUS_DAYS,
  referred: REFERRED_BONUS_DAYS,
  monthlyCap: MAX_REFERRER_BONUS_PER_MONTH,
} as const
