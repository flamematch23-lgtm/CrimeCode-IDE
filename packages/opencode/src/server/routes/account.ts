import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { HTTPException } from "hono/http-exception"
import { Log } from "../../util/log"
import {
  listSessionsForCustomer,
  revokeAllSessionsForCustomer,
  revokeSession,
} from "../../license/auth"
import {
  findCustomerByIdOrTelegram,
  getActiveLicenseForCustomer,
  listAuditForCustomer,
  listLicensesForCustomer,
} from "../../license/store"
import { makeToken } from "../../license/token"
import {
  claimAndApplyReferral,
  getOrCreateReferralCode,
  isEligibleForReferralClaim,
  listReferralsByCustomer,
  REFERRAL_BONUS,
  resolveReferralCode,
} from "../../license/referrals"

const log = Log.create({ service: "account" })

function requireCustomer(c: { get: (k: never) => unknown }): string {
  const id = c.get("customer_id" as never) as string | undefined
  if (!id) {
    throw new HTTPException(401, { message: "this endpoint requires Bearer authentication" })
  }
  return id
}

// /account/* — self-service endpoints for the customer dashboard. Every
// route is scoped to the verified Bearer token's customer_id, so a caller
// can only ever read or mutate their own data. No admin powers here.
export const AccountRoutes = () =>
  new Hono()
    // GET /account/me — identity card. Pulled from the license DB by the
    // customer_id encoded in the Bearer token.
    .get(
      "/me",
      describeRoute({
        summary: "Get the calling customer's identity",
        operationId: "account.me",
        responses: {
          200: { description: "Customer info" },
          401: { description: "Bearer token required" },
        },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const customer = findCustomerByIdOrTelegram(customerId)
        if (!customer) {
          throw new HTTPException(404, { message: "customer not found" })
        }
        return c.json({
          customer_id: customer.id,
          telegram: customer.telegram,
          telegram_user_id: customer.telegram_user_id,
          email: customer.email,
          status: customer.approval_status,
          created_at: customer.created_at,
          approved_at: customer.approved_at,
          rejected_reason: customer.rejected_reason,
        })
      },
    )
    // GET /account/me/devices — every auth_session row for this customer,
    // active or revoked, ordered by most-recently-seen first.
    .get(
      "/me/devices",
      describeRoute({
        summary: "List the calling customer's devices / sessions",
        operationId: "account.me.devices",
        responses: { 200: { description: "Device list" } },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const sessions = listSessionsForCustomer(customerId)
        return c.json({
          devices: sessions.map((s) => ({
            id: s.id,
            device_label: s.device_label,
            created_at: s.created_at,
            last_seen_at: s.last_seen_at,
            revoked_at: s.revoked_at,
            active: s.revoked_at == null,
          })),
        })
      },
    )
    // DELETE /account/me/devices/:sid — revoke a single session. The owner
    // check is implicit: we only flip rows whose customer_id matches and
    // who aren't already revoked. Returns 404 if the session id doesn't
    // belong to this customer (or doesn't exist), so the response shape
    // doesn't leak across customers.
    .delete(
      "/me/devices/:sid",
      describeRoute({
        summary: "Revoke a single device / session",
        operationId: "account.me.device.revoke",
        responses: { 200: { description: "Revoked" }, 404: { description: "Not yours / not found" } },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const sid = c.req.param("sid")
        if (!sid) throw new HTTPException(400, { message: "missing session id" })
        const sessions = listSessionsForCustomer(customerId)
        const owns = sessions.some((s) => s.id === sid)
        if (!owns) {
          // Don't disclose whether `sid` exists for another customer.
          throw new HTTPException(404, { message: "device not found" })
        }
        const ok = revokeSession(sid)
        log.info("device revoked", { customerId, sid, ok })
        return c.json({ revoked: ok })
      },
    )
    // GET /account/me/license — return the calling customer's currently
    // usable license + a freshly-regenerated activation token. Used by
    // the renderer right after a successful Telegram / username sign-in
    // to skip the manual "paste token" step: if the user already paid,
    // the desktop app applies the license automatically.
    //
    // The token is regenerated deterministically from the license row
    // (makeToken with the same payload always yields the same JWT), so
    // the customer can re-fetch from any device — no per-device state.
    // Returns 200 with `{license: null, token: null}` (not 404) when
    // there's no active license, so the caller can branch cleanly.
    .get(
      "/me/license",
      describeRoute({
        summary: "Get the calling customer's active license + activation token",
        operationId: "account.me.license",
        responses: {
          200: { description: "License or null" },
          401: { description: "Bearer token required" },
        },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const license = getActiveLicenseForCustomer(customerId)
        if (!license) {
          return c.json({ license: null, token: null })
        }
        const { token } = makeToken({
          l: license.id,
          i: license.interval,
          t: license.issued_at,
          ...(license.expires_at != null ? { e: license.expires_at } : {}),
        })
        return c.json({
          license: {
            id: license.id,
            interval: license.interval,
            issued_at: license.issued_at,
            expires_at: license.expires_at,
          },
          token,
        })
      },
    )
    // GET /account/me/licenses — full license history for the calling
    // customer (active + revoked + expired). Useful for an "Order
    // history" / "License history" panel in the dashboard.
    .get(
      "/me/licenses",
      describeRoute({
        summary: "List all licenses for the calling customer",
        operationId: "account.me.licenses",
        responses: { 200: { description: "License list" } },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const licenses = listLicensesForCustomer(customerId)
        return c.json({
          licenses: licenses.map((l) => ({
            id: l.id,
            interval: l.interval,
            issued_at: l.issued_at,
            expires_at: l.expires_at,
            revoked_at: l.revoked_at,
            revoked_reason: l.revoked_reason,
          })),
        })
      },
    )
    // GET /account/me/referral — get (or create) the calling customer's
    // shareable referral code and a count of claims they've earned.
    .get(
      "/me/referral",
      describeRoute({
        summary: "Calling customer's referral code + history",
        operationId: "account.me.referral",
        responses: { 200: { description: "Referral code + claim list" } },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const row = getOrCreateReferralCode(customerId)
        const claims = listReferralsByCustomer(customerId, 50)
        return c.json({
          code: row.code,
          shareUrl: `https://crimecode.cc/r/${row.code}`,
          bonus: REFERRAL_BONUS,
          eligibleToRedeem: isEligibleForReferralClaim(customerId),
          claims: claims.map((c) => ({
            referred_customer_id: c.referred_customer_id,
            claimed_at: c.claimed_at,
            referrer_bonus_days: c.referrer_bonus_days,
          })),
        })
      },
    )
    // POST /account/me/redeem-referral — apply a referral code AFTER signup.
    // Used by the dashboard's "Got a code from a friend? Redeem it" form.
    // Eligibility is gated by isEligibleForReferralClaim (24h post-signup,
    // single redemption per customer) — see the helper for the rules.
    .post(
      "/me/redeem-referral",
      describeRoute({
        summary: "Redeem a referral code post-signup",
        operationId: "account.me.redeem.referral",
        responses: {
          200: { description: "Bonus applied" },
          400: { description: "Bad code or ineligible" },
        },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const body = (await c.req.json().catch(() => ({}))) as { code?: string }
        const code = (body.code ?? "").trim().toUpperCase()
        if (!code || !/^[A-Z0-9]{4,32}$/.test(code)) {
          return c.json({ error: "bad_code" }, 400)
        }
        const r = claimAndApplyReferral({ code, referredCustomerId: customerId })
        if (!r.ok) return c.json({ error: r.reason }, 400)
        log.info("referral redeemed via dashboard", {
          customer: customerId,
          referrer: r.referrer_customer_id,
          bonus_referred: r.referred_bonus_days,
        })
        return c.json({
          ok: true,
          referrer_bonus_days: r.referrer_bonus_days,
          referred_bonus_days: r.referred_bonus_days,
        })
      },
    )
    // GET /account/me/resolve-referral?code=ABC — peek at a code without
    // committing. Used by the signup form to render "🎁 +3 day bonus from
    // your friend's link!" the moment the code is typed in.
    .get(
      "/me/resolve-referral",
      describeRoute({
        summary: "Validate a referral code (read-only)",
        operationId: "account.me.resolve.referral",
        responses: { 200: { description: "Resolution result" } },
      }),
      async (c) => {
        const code = (c.req.query("code") ?? "").trim().toUpperCase()
        if (!code || !/^[A-Z0-9]{4,32}$/.test(code)) {
          return c.json({ valid: false, reason: "bad_code" })
        }
        const owner = resolveReferralCode(code)
        if (!owner) return c.json({ valid: false, reason: "unknown_code" })
        return c.json({
          valid: true,
          bonus_for_you: REFERRAL_BONUS.referred,
          bonus_for_them: REFERRAL_BONUS.referrer,
        })
      },
    )
    // GET /account/me/audit — read-only ledger of actions involving this
    // customer (license issue, approval, revocation, …). Trust + surface
    // for the dashboard's "Activity" panel; not a real-time stream
    // (audit is append-only, polling is fine).
    .get(
      "/me/audit",
      describeRoute({
        summary: "Audit log entries that reference the calling customer",
        operationId: "account.me.audit",
        responses: { 200: { description: "Audit list" } },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "100", 10), 1), 500)
        const rows = listAuditForCustomer(customerId, limit)
        return c.json({ entries: rows })
      },
    )
    // POST /account/me/devices/logout-all — kick every active session for
    // this customer in one shot. Returns the count flipped to revoked.
    .post(
      "/me/devices/logout-all",
      describeRoute({
        summary: "Sign out everywhere for this customer",
        operationId: "account.me.logout.all",
        responses: { 200: { description: "Number of sessions revoked" } },
      }),
      async (c) => {
        const customerId = requireCustomer(c)
        const n = revokeAllSessionsForCustomer(customerId)
        log.info("logout-all", { customerId, revoked: n })
        return c.json({ revoked: n })
      },
    )
