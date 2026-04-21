import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Flag } from "../../flag/flag"

// ── in-memory invite state ──────────────────────────────────────────────────

interface Invite {
  code: string
  relay: string
  created: number
  expires: number
}

const active = new Map<string, Invite>()

const InviteSchema = z.object({
  code: z.string(),
  relay: z.string(),
  created: z.number(),
  expires: z.number(),
  remaining: z.number(),
})

// ── relay communication ─────────────────────────────────────────────────────

async function register(relay: string, url: string, token?: string): Promise<{ code: string; expires: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  const admin = process.env.CRIMECODE_RELAY_ADMIN_TOKEN
  if (admin) headers["authorization"] = `Bearer ${admin}`

  const res = await fetch(`${relay}/invite`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, token }),
  })
  if (!res.ok) throw new Error(`relay error: ${res.status} ${await res.text()}`)
  return res.json()
}

async function revoke(relay: string, code: string): Promise<void> {
  const headers: Record<string, string> = {}
  const admin = process.env.CRIMECODE_RELAY_ADMIN_TOKEN
  if (admin) headers["authorization"] = `Bearer ${admin}`

  const res = await fetch(`${relay}/invite/${code}`, {
    method: "DELETE",
    headers,
  })
  if (!res.ok && res.status !== 404) throw new Error(`relay error: ${res.status} ${await res.text()}`)
}

export async function resolve(relay: string, code: string): Promise<{ url: string; token?: string }> {
  const res = await fetch(`${relay}/invite/${code}`)
  if (!res.ok) throw new Error(`invite not found or expired`)
  return res.json()
}

// ── public API for CLI ──────────────────────────────────────────────────────

export namespace Invite {
  export function list() {
    const now = Date.now()
    return [...active.values()]
      .filter((inv) => inv.expires > now)
      .map((inv) => ({
        ...inv,
        remaining: Math.max(0, inv.expires - now),
      }))
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

export const InviteRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List active invites",
        description: "List all active workspace invite codes.",
        operationId: "invite.list",
        responses: {
          200: {
            description: "Active invites",
            content: {
              "application/json": {
                schema: resolver(z.array(InviteSchema)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Invite.list())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create workspace invite",
        description:
          "Generate an invite code and register it on the relay. Other users can join this workspace using the code.",
        operationId: "invite.create",
        responses: {
          200: {
            description: "Invite created",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    code: z.string(),
                    relay: z.string(),
                    expires: z.number(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          relay: z.string().describe("Relay server URL"),
          url: z.string().describe("Public URL of this server"),
          token: z.string().optional().describe("Optional join token for extra security"),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const result = await register(body.relay, body.url, body.token)
          const inv: Invite = {
            code: result.code,
            relay: body.relay,
            created: Date.now(),
            expires: result.expires,
          }
          active.set(result.code, inv)
          return c.json({ code: result.code, relay: body.relay, expires: result.expires })
        } catch (e: any) {
          return c.json({ error: e.message }, 400)
        }
      },
    )
    .delete(
      "/:code",
      describeRoute({
        summary: "Revoke invite",
        description: "Revoke an active invite code.",
        operationId: "invite.revoke",
        responses: {
          200: {
            description: "Invite revoked",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const code = c.req.param("code").toUpperCase()
        const inv = active.get(code)
        if (!inv) return c.json({ error: "invite not found" }, 404)
        try {
          await revoke(inv.relay, code)
        } catch {
          // relay may be down, still remove locally
        }
        active.delete(code)
        return c.json({ ok: true })
      },
    ),
)
