import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { HTTPException } from "hono/http-exception"
import { Log } from "../../util/log"
import {
  listSessionsForCustomer,
  revokeAllSessionsForCustomer,
  revokeSession,
} from "../../license/auth"
import { findCustomerByIdOrTelegram } from "../../license/store"

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
