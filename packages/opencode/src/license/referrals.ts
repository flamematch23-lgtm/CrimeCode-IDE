import { randomBytes } from "node:crypto"
import { getDb } from "./db"
import { Log } from "../util/log"

const log = Log.create({ service: "referrals" })

function auditEntry(action: string, details: unknown): void {
  try {
    getDb()
      .prepare("INSERT INTO audit (action, details, ts) VALUES (?, ?, ?)")
      .run(action, JSON.stringify(details ?? null), Math.floor(Date.now() / 1000))
  } catch (err) {
    // audit table may not exist in the rare new-DB-pre-migrations window;
    // log + swallow so referral bookkeeping never blocks the flow.
    log.warn("audit insert failed", { action, error: err instanceof Error ? err.message : String(err) })
  }
}

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

/**
 * Push `days` of bonus onto a customer's active license: if they have one
 * with an `expires_at` in the future we extend it in place; otherwise we
 * stash the days on `customers.pending_referral_days` so the next trial
 * approval (or paid-license issue) can mint a longer license.
 *
 * Returns `"applied"` (extended an existing license), `"queued"` (queued
 * as pending for the next trial), or `"skipped"` (customer not found /
 * already has a non-expiring lifetime license / days <= 0).
 */
export function applyReferralBonusToTrial(
  customerId: string,
  days: number,
  reason: "referrer" | "referred",
): "applied" | "queued" | "skipped" {
  if (!Number.isFinite(days) || days <= 0) return "skipped"
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const customer = db
    .prepare<{ id: string; approval_status: string }, [string]>(
      "SELECT id, approval_status FROM customers WHERE id = ?",
    )
    .get(customerId)
  if (!customer) return "skipped"

  // Active license = newest, not revoked, not yet expired (or never-expires).
  const lic = db
    .prepare<{ id: string; expires_at: number | null; interval: string }, [string, number]>(
      `SELECT id, expires_at, interval FROM licenses
        WHERE customer_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY issued_at DESC LIMIT 1`,
    )
    .get(customerId, now)

  if (lic && lic.expires_at != null) {
    const newExpiry = lic.expires_at + days * 86400
    db.prepare("UPDATE licenses SET expires_at = ? WHERE id = ?").run(newExpiry, lic.id)
    auditEntry("referral.bonus_applied", {
      customer_id: customerId,
      license_id: lic.id,
      days,
      reason,
      new_expires_at: newExpiry,
    })
    log.info("referral bonus applied to active license", {
      customer: customerId,
      license: lic.id,
      days,
      reason,
    })
    return "applied"
  }

  if (lic && lic.expires_at == null) {
    // Lifetime license — bonus is meaningless. Skip.
    log.info("skip bonus on lifetime license", { customer: customerId, days, reason })
    return "skipped"
  }

  // No active license yet (typical for the brand-new referred user before
  // approval, or for a referrer whose trial already lapsed). Queue the bonus.
  db.prepare(
    "UPDATE customers SET pending_referral_days = COALESCE(pending_referral_days, 0) + ? WHERE id = ?",
  ).run(days, customerId)
  auditEntry("referral.bonus_queued", {
    customer_id: customerId,
    days,
    reason,
  })
  log.info("referral bonus queued for next trial", {
    customer: customerId,
    days,
    reason,
  })
  return "queued"
}

/**
 * Read + zero out any pending bonus days for the given customer. Called
 * by the approval flow so the trial that gets handed out includes the
 * bonus baked in. Returns the number of days that were pending (0 if none).
 */
export function consumePendingReferralBonus(customerId: string): number {
  const db = getDb()
  const row = db
    .prepare<{ pending_referral_days: number | null }, [string]>(
      "SELECT pending_referral_days FROM customers WHERE id = ?",
    )
    .get(customerId)
  const pending = row?.pending_referral_days ?? 0
  if (pending > 0) {
    db.prepare("UPDATE customers SET pending_referral_days = 0 WHERE id = ?").run(customerId)
    auditEntry("referral.bonus_consumed", {
      customer_id: customerId,
      days: pending,
    })
    log.info("consumed pending referral bonus", { customer: customerId, days: pending })
  }
  return pending
}

/**
 * Check whether a customer is "brand new" enough that a referral claim is
 * still allowed. We only let claims happen in the first 24 hours after
 * signup — past that, the bonus would be retroactive freebies for users
 * who never actually came in via a referral link.
 */
export function isEligibleForReferralClaim(customerId: string): boolean {
  const db = getDb()
  const row = db
    .prepare<{ created_at: number; referral_code_used: string | null }, [string]>(
      "SELECT created_at, referral_code_used FROM customers WHERE id = ?",
    )
    .get(customerId)
  if (!row) return false
  if (row.referral_code_used) return false // already redeemed once
  const ageSec = Math.floor(Date.now() / 1000) - row.created_at
  return ageSec <= 24 * 3600
}

/**
 * Stamp the customer with the code they used so we can render it on the
 * dashboard ("Welcome bonus applied: +3 days from <code>") and prevent
 * a second redemption.
 */
export function markCustomerUsedReferralCode(customerId: string, code: string): void {
  getDb()
    .prepare("UPDATE customers SET referral_code_used = ? WHERE id = ?")
    .run(code.toUpperCase(), customerId)
}

/**
 * Combined transactional helper: validate the code, write the claim row,
 * stamp the customer, push the bonus onto whichever side currently has a
 * license — or queue it if not. Idempotent on (referrer, referred) pair.
 */
export function claimAndApplyReferral(opts: {
  code: string
  referredCustomerId: string
}):
  | { ok: true; referrer_customer_id: string; referrer_bonus_days: number; referred_bonus_days: number }
  | { ok: false; reason: "unknown_code" | "self_referral" | "already_claimed" | "monthly_cap" | "ineligible" } {
  if (!isEligibleForReferralClaim(opts.referredCustomerId)) {
    return { ok: false, reason: "ineligible" }
  }
  const r = claimReferral(opts)
  if (!r.ok) return r
  markCustomerUsedReferralCode(opts.referredCustomerId, opts.code)
  // Apply the referrer's reward to their active license (or queue it),
  // and queue the referred user's bonus so it lands on their trial when
  // the admin approves. The referred user has no license yet at this
  // point, so applyReferralBonusToTrial will return "queued" — exactly
  // what we want.
  applyReferralBonusToTrial(r.referrer_customer_id, r.referrer_bonus_days, "referrer")
  applyReferralBonusToTrial(opts.referredCustomerId, r.referred_bonus_days, "referred")
  // Mark the claim row as credited so admin tooling can tell at a glance.
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare(
      `UPDATE referral_claims
         SET referrer_credited_at = ?, referred_credited_at = ?
       WHERE referrer_customer_id = ? AND referred_customer_id = ?`,
    )
    .run(now, now, r.referrer_customer_id, opts.referredCustomerId)
  return r
}
