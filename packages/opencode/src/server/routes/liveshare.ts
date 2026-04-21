import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "../error"
import { LiveShare } from "../../share/live"
import { lazy } from "../../util/lazy"

const ParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  joined: z.number(),
  session: z.string().nullable().optional(),
  role: z.enum(["viewer", "editor"]).optional(),
})

const HubSchema = z.object({
  code: z.string(),
  port: z.number(),
  hostname: z.string(),
  relay: z.string().nullable(),
  locked: z.boolean(),
  token: z.string().nullable().optional(),
  participants: z.array(ParticipantSchema),
})

export const LiveShareRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get live share status",
        description: "Get the current live share session status and participants.",
        operationId: "liveshare.status",
        responses: {
          200: {
            description: "Live share status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    active: z.boolean(),
                    hub: HubSchema.nullable(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const hub = LiveShare.active()
        if (!hub) return c.json({ active: false, hub: null })
        return c.json({
          active: true,
          hub: {
            code: hub.code,
            port: hub.port,
            hostname: hub.hostname,
            relay: hub.relay,
            locked: !!hub.token,
            token: hub.token,
            participants: LiveShare.listParticipants(),
          },
        })
      },
    )
    .post(
      "/start",
      describeRoute({
        summary: "Start live share session",
        description: "Start a new live share session as host.",
        operationId: "liveshare.start",
        responses: {
          200: {
            description: "Session started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    code: z.string(),
                    port: z.number(),
                    hostname: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(409),
        },
      }),
      validator(
        "json",
        z
          .object({
            port: z.number().optional(),
            hostname: z.string().optional(),
            relay: z.string().optional(),
            token: z.string().optional(),
          })
          .optional(),
      ),
      async (c) => {
        try {
          const body = c.req.valid("json")
          const result = await LiveShare.start({
            port: body?.port,
            hostname: body?.hostname,
            relay: body?.relay,
            token: body?.token,
          })
          return c.json(result)
        } catch (e: any) {
          return c.json({ error: e.message }, 409)
        }
      },
    )
    .post(
      "/stop",
      describeRoute({
        summary: "Stop live share session",
        description: "Stop the active live share session.",
        operationId: "liveshare.stop",
        responses: {
          200: {
            description: "Session stopped",
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
        try {
          LiveShare.stop()
          return c.json({ ok: true })
        } catch (e: any) {
          return c.json({ error: e.message }, 404)
        }
      },
    )
    .post(
      "/kick/:id",
      describeRoute({
        summary: "Kick a participant",
        description: "Kick a participant from the live share session.",
        operationId: "liveshare.kick",
        responses: {
          200: {
            description: "Participant kicked",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator(
        "json",
        z
          .object({
            reason: z.string().optional(),
          })
          .optional(),
      ),
      async (c) => {
        const id = c.req.param("id")
        try {
          const body = c.req.valid("json")
          LiveShare.kick(id, body?.reason)
          return c.json({ ok: true })
        } catch (e: any) {
          return c.json({ error: e.message }, 404)
        }
      },
    )
    .get(
      "/participants",
      describeRoute({
        summary: "List participants",
        description: "List all participants in the active live share session.",
        operationId: "liveshare.participants",
        responses: {
          200: {
            description: "Participants list",
            content: {
              "application/json": {
                schema: resolver(z.array(ParticipantSchema)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(LiveShare.listParticipants())
      },
    )
    .post(
      "/role/:id",
      describeRoute({
        summary: "Set participant role",
        description: "Set a participant's role to viewer or editor.",
        operationId: "liveshare.setRole",
        responses: {
          200: {
            description: "Role updated",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("json", z.object({ role: z.enum(["viewer", "editor"]) })),
      async (c) => {
        const id = c.req.param("id")
        try {
          const body = c.req.valid("json")
          LiveShare.setRole(id, body.role)
          return c.json({ ok: true })
        } catch (e: any) {
          return c.json({ error: e.message }, 404)
        }
      },
    ),
)
