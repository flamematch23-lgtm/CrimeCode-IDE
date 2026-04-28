import { createHash } from "node:crypto"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { compress } from "hono/compress"
import { cors } from "hono/cors"
import { proxy } from "hono/proxy"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Project } from "../project/project"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { Global } from "../global"
import { WorkspaceID } from "../control-plane/schema"
import { ProviderID } from "../provider/schema"
import { WorkspaceRouterMiddleware } from "../control-plane/workspace-router-middleware"
import { ProjectRoutes } from "./routes/project"
import { SecurityRoutes } from "./routes/security"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { EventRoutes } from "./routes/event"
import { InstanceBootstrap } from "../project/bootstrap"
import { NotFoundError } from "../storage/db"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { Filesystem } from "@/util/filesystem"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { LiveShareRoutes } from "./routes/liveshare"
import { InviteRoutes } from "./routes/invite"
import { LicenseRoutes } from "./routes/license"
import { SyncRoutes } from "./routes/sync"
import { AccountRoutes } from "./routes/account"
import { startTelegramBot } from "../license/telegram"
import { startTeamReaper } from "../license/team-reaper"
import { startPaymentPoller } from "../license/poller"
import { startBackupScheduler } from "../license/backup"
import { startRenewalReminders } from "../license/reminders"
import { captureException, initSentry } from "../license/sentry"
import { MDNS } from "./mdns"
import { lazy } from "@/util/lazy"
import { initProjectors } from "./projectors"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

initProjectors()

export namespace Server {
  const log = Log.create({ service: "server" })
  const DEFAULT_CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"
  const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
    ? Promise.resolve(null)
    : // @ts-expect-error - generated file at build time
      import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

  const zipped = compress()

  const skipCompress = (path: string, method: string) => {
    if (path === "/event" || path === "/global/event" || path === "/global/sync-event") return true
    if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return true
    return false
  }

  export const Default = lazy(() => createApp({}))

  export const createApp = (opts: { cors?: string[] }): Hono => {
    const app = new Hono()
    return app
      .onError((err, c) => {
        log.error("failed", {
          error: err,
        })
        captureException(err, {
          tags: { surface: "http" },
          extra: { path: c.req.path, method: c.req.method },
        })
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode
          if (err instanceof NotFoundError) status = 404
          else if (err instanceof Provider.ModelNotFoundError) status = 400
          else if (err.name === "ProviderAuthValidationFailed") status = 400
          else if (err.name.startsWith("Worktree")) status = 400
          else status = 500
          return c.json(err.toObject(), { status })
        }
        if (err instanceof HTTPException) return err.getResponse()
        const message = err instanceof Error && err.stack ? err.stack : err.toString()
        return c.json(new NamedError.Unknown({ message }).toObject(), {
          status: 500,
        })
      })
      // CORS must run BEFORE basicAuth so that 401 responses still carry the
      // Access-Control-Allow-Origin header; otherwise browsers surface the
      // 401 as "TypeError: Failed to fetch" with no diagnostic detail.
      .use(
        cors({
          maxAge: 86_400,
          origin(input) {
            if (!input) return

            if (input.startsWith("http://localhost:")) return input
            if (input.startsWith("http://127.0.0.1:")) return input
            if (
              input === "tauri://localhost" ||
              input === "http://tauri.localhost" ||
              input === "https://tauri.localhost"
            )
              return input

            // Electron renderer (file://, app://, custom protocols → Origin: null)
            if (input === "null") return input
            if (input.startsWith("file://")) return input
            if (input.startsWith("app://")) return input

            // *.opencode.ai (https only, adjust if needed)
            if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
              return input
            }
            if (opts?.cors?.includes(input)) {
              return input
            }

            return
          },
        }),
      )
      .use(async (c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        // /global/health must be reachable without auth — it's the standard
        // liveness/readiness probe used by:
        //   - The desktop client's ConnectionGate at app startup (often
        //     before the Bearer JWT is hydrated from localStorage).
        //   - Fly.io / load balancer health checks.
        //   - Anyone wanting to see the deployed version + commit hash.
        // Returns only {healthy, version, commit} — no PII, no secrets.
        if (c.req.path === "/global/health") return next()
        // /account/me/resolve-referral is intentionally public — it's
        // called by the /r/<CODE> referral-landing page BEFORE the user
        // signs up (so they can see "🎁 Valid! +3 days bonus" before
        // committing). Returns only bonus constants and a valid/invalid
        // bit for the supplied code; no PII, no enumeration risk (codes
        // are 8-32 chars from a 32-char alphabet).
        if (c.req.path === "/account/me/resolve-referral") return next()
        // The license sub-app has its own auth layer (Bearer JWT for user
        // endpoints, admin Basic Auth for admin endpoints, and explicit
        // public sub-paths like /license/auth/start, /license/order/.../status,
        // /license/order/:id/status). Let it through unconditionally — it
        // enforces its own authz downstream.
        if (c.req.path.startsWith("/license/")) return next()
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return next()
        // Accept EITHER classic Basic Auth with the server password OR a
        // Bearer JWT issued by /license/auth/poll. This lets the web app
        // reach /global /session /project etc. with only a Telegram sign-in.
        const auth = c.req.header("Authorization") ?? ""
        if (auth.startsWith("Bearer ")) {
          const { verifySessionToken, touchSession } = await import("../license/auth")
          const v = verifySessionToken(auth.slice(7))
          if (v.ok) {
            touchSession(v.payload.sid)
            // Expose verified identity to downstream handlers (e.g. /sync/*)
            // so they can scope writes/reads to this customer.
            c.set("customer_id" as never, v.payload.sub as never)
            c.set("telegram_user_id" as never, v.payload.tg as never)
            return next()
          }
        }
        const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skipLogging = c.req.path === "/log"
        if (!skipLogging) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skipLogging) {
          timer.stop()
        }
      })
      .use((c, next) => {
        if (skipCompress(c.req.path, c.req.method)) return next()
        return zipped(c, next)
      })
      .route("/global", GlobalRoutes())
      .route("/security", SecurityRoutes())
      .route("/license", LicenseRoutes())
      // /sync/* is auth-gated (Bearer token, customer-scoped) but does NOT
      // require a local project Instance — must be mounted BEFORE the
      // Instance.provide middleware below.
      .route("/sync", SyncRoutes())
      // /account/* — same idea: customer-scoped self-service endpoints
      // (identity, devices, logout) that don't need a project context.
      .route("/account", AccountRoutes())
      .put(
        "/auth/:providerID",
        describeRoute({
          summary: "Set auth credentials",
          description: "Set authentication credentials",
          operationId: "auth.set",
          responses: {
            200: {
              description: "Successfully set authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        validator("json", Auth.Info.zod),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const info = c.req.valid("json")
          await Auth.set(providerID, info)
          return c.json(true)
        },
      )
      .delete(
        "/auth/:providerID",
        describeRoute({
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
          operationId: "auth.remove",
          responses: {
            200: {
              description: "Successfully removed authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          await Auth.remove(providerID)
          return c.json(true)
        },
      )
      .use(async (c, next) => {
        if (c.req.path === "/log") return next()
        const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
        const directory = Filesystem.resolve(
          (() => {
            try {
              return decodeURIComponent(raw)
            } catch {
              return raw
            }
          })(),
        )

        return Instance.provide({
          directory,
          init: InstanceBootstrap,
          async fn() {
            // Multi-tenant tag-on-touch + ownership enforcement. Runs only
            // for Bearer-authenticated callers; Basic-auth (local sidecar)
            // callers don't have a customer_id and fall through unchanged.
            const customerId = c.get("customer_id" as never) as string | undefined
            if (customerId) {
              const outcome = Project.assertOrTagOwnership(Instance.project.id, customerId)
              if (outcome === "forbidden") {
                throw new HTTPException(403, {
                  message: "this project belongs to a different account",
                })
              }
            }
            return next()
          },
        })
      })
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "opencode",
              version: "0.0.3",
              description: "opencode api",
            },
            openapi: "3.1.1",
          },
        }),
      )
      .use(
        validator(
          "query",
          z.object({
            directory: z.string().optional(),
            workspace: z.string().optional(),
          }),
        ),
      )
      .use(WorkspaceRouterMiddleware)
      .route("/project", ProjectRoutes())
      .route("/pty", PtyRoutes())
      .route("/config", ConfigRoutes())
      .route("/experimental", ExperimentalRoutes())
      .route("/session", SessionRoutes())
      .route("/permission", PermissionRoutes())
      .route("/question", QuestionRoutes())
      .route("/provider", ProviderRoutes())
      .route("/", FileRoutes())
      .route("/", EventRoutes())
      .route("/mcp", McpRoutes())
      .route("/liveshare", LiveShareRoutes())
      .route("/invite", InviteRoutes())
      .route("/tui", TuiRoutes())
      .post(
        "/instance/dispose",
        describeRoute({
          summary: "Dispose instance",
          description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          operationId: "instance.dispose",
          responses: {
            200: {
              description: "Instance disposed",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
          },
        }),
        async (c) => {
          await Instance.dispose()
          return c.json(true)
        },
      )
      .get(
        "/path",
        describeRoute({
          summary: "Get paths",
          description: "Retrieve the current working directory and related path information for the OpenCode instance.",
          operationId: "path.get",
          responses: {
            200: {
              description: "Path",
              content: {
                "application/json": {
                  schema: resolver(
                    z
                      .object({
                        home: z.string(),
                        state: z.string(),
                        config: z.string(),
                        worktree: z.string(),
                        directory: z.string(),
                      })
                      .meta({
                        ref: "Path",
                      }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json({
            home: Global.Path.home,
            state: Global.Path.state,
            config: Global.Path.config,
            worktree: Instance.worktree,
            directory: Instance.directory,
          })
        },
      )
      .get(
        "/vcs",
        describeRoute({
          summary: "Get VCS info",
          description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
          operationId: "vcs.get",
          responses: {
            200: {
              description: "VCS info",
              content: {
                "application/json": {
                  schema: resolver(Vcs.Info),
                },
              },
            },
          },
        }),
        async (c) => {
          const branch = await Vcs.branch()
          return c.json({
            branch,
          })
        },
      )
      .get(
        "/command",
        describeRoute({
          summary: "List commands",
          description: "Get a list of all available commands in the OpenCode system.",
          operationId: "command.list",
          responses: {
            200: {
              description: "List of commands",
              content: {
                "application/json": {
                  schema: resolver(Command.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const commands = await Command.list()
          return c.json(commands)
        },
      )
      .post(
        "/log",
        describeRoute({
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
          operationId: "app.log",
          responses: {
            200: {
              description: "Log entry written successfully",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            service: z.string().meta({ description: "Service name for the log entry" }),
            level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
            message: z.string().meta({ description: "Log message" }),
            extra: z
              .record(z.string(), z.any())
              .optional()
              .meta({ description: "Additional metadata for the log entry" }),
          }),
        ),
        async (c) => {
          const { service, level, message, extra } = c.req.valid("json")
          const logger = Log.create({ service })

          switch (level) {
            case "debug":
              logger.debug(message, extra)
              break
            case "info":
              logger.info(message, extra)
              break
            case "error":
              logger.error(message, extra)
              break
            case "warn":
              logger.warn(message, extra)
              break
          }

          return c.json(true)
        },
      )
      .get(
        "/agent",
        describeRoute({
          summary: "List agents",
          description: "Get a list of all available AI agents in the OpenCode system.",
          operationId: "app.agents",
          responses: {
            200: {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: resolver(Agent.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const modes = await Agent.list()
          return c.json(modes)
        },
      )
      .get(
        "/skill",
        describeRoute({
          summary: "List skills",
          description: "Get a list of all available skills in the OpenCode system.",
          operationId: "app.skills",
          responses: {
            200: {
              description: "List of skills",
              content: {
                "application/json": {
                  schema: resolver(Skill.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const skills = await Skill.all()
          return c.json(skills)
        },
      )
      .get(
        "/lsp",
        describeRoute({
          summary: "Get LSP status",
          description: "Get LSP server status",
          operationId: "lsp.status",
          responses: {
            200: {
              description: "LSP server status",
              content: {
                "application/json": {
                  schema: resolver(LSP.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await LSP.status())
        },
      )
      .get(
        "/formatter",
        describeRoute({
          summary: "Get formatter status",
          description: "Get formatter status",
          operationId: "formatter.status",
          responses: {
            200: {
              description: "Formatter status",
              content: {
                "application/json": {
                  schema: resolver(Format.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await Format.status())
        },
      )
      .all("/*", async (c) => {
        const embeddedWebUI = await embeddedUIPromise
        const path = c.req.path

        if (embeddedWebUI) {
          const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
          if (!match) return c.json({ error: "Not Found" }, 404)
          const file = Bun.file(match)
          if (await file.exists()) {
            c.header("Content-Type", file.type)
            if (file.type.startsWith("text/html")) {
              c.header("Content-Security-Policy", DEFAULT_CSP)
            }
            return c.body(await file.arrayBuffer())
          } else {
            return c.json({ error: "Not Found" }, 404)
          }
        } else {
          const response = await proxy(`https://app.opencode.ai${path}`, {
            ...c.req,
            headers: {
              ...c.req.raw.headers,
              host: "app.opencode.ai",
            },
          })
          const match = response.headers.get("content-type")?.includes("text/html")
            ? (await response.clone().text()).match(
                /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
              )
            : undefined
          const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
          response.headers.set("Content-Security-Policy", csp(hash))
          return response
        }
      }) as unknown as Hono
  }

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(Default(), {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  /** @deprecated do not use this dumb shit */
  export let url: URL

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    url = new URL(`http://${opts.hostname}:${opts.port}`)
    const app = createApp(opts)
    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: app.fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    // Initialise Sentry first so any errors during the rest of boot are
    // reported. No-op when SENTRY_DSN is unset (local dev).
    void initSentry().catch(() => undefined)

    // License Telegram bot — only runs when both LICENSE_HMAC_SECRET and
    // TELEGRAM_BOT_TOKEN are set, so it's a no-op for local dev.
    if (process.env.LICENSE_HMAC_SECRET && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        startTelegramBot()
      } catch (err) {
        log.warn("failed to start telegram bot", { error: err instanceof Error ? err.message : String(err) })
        captureException(err, { tags: { surface: "telegram-bot-init" } })
      }
    }
    // Crypto payment poller — only runs when at least one wallet env var is
    // configured (BTC_WALLET_ADDRESS / LTC_WALLET_ADDRESS / ETH_WALLET_ADDRESS).
    if (process.env.LICENSE_HMAC_SECRET && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        startPaymentPoller()
      } catch (err) {
        log.warn("failed to start payment poller", { error: err instanceof Error ? err.message : String(err) })
      }
    }
    // Off-site backup of the license DB (Tigris / S3 / R2). Snapshots every
    // 12h via SQLite VACUUM INTO + gzip + AWS SigV4 PUT.
    try {
      startBackupScheduler()
    } catch (err) {
      log.warn("failed to start backup scheduler", { error: err instanceof Error ? err.message : String(err) })
      captureException(err, { tags: { surface: "backup-init" } })
    }
    // Team-session reaper — sweeps every 30s for sessions that haven't
    // heartbeated in 60s and marks them ended (with `session_ended` event).
    // Without this a host crash leaves a session "active" for up to 90s,
    // blocking new sessions on the same team and lying to subscribers.
    try {
      startTeamReaper()
    } catch (err) {
      log.warn("failed to start team reaper", { error: err instanceof Error ? err.message : String(err) })
      captureException(err, { tags: { surface: "team-reaper-init" } })
    }
    // Cloud-sync auto-hydrate: pick up the {api, token} pair the
    // renderer wrote during a previous successful login so a sidecar
    // restart doesn't drop the cloud-sync configuration. Without this
    // "Sync now" surfaced "not configured" after every restart, even
    // though the user had configured it minutes earlier.
    void (async () => {
      try {
        const { CloudClient } = await import("../sync/cloud-client")
        const ok = await CloudClient.hydrateFromDisk()
        if (ok) log.info("cloud-sync rehydrated from disk")
      } catch (err) {
        log.warn("cloud-sync hydrate failed", { error: err instanceof Error ? err.message : String(err) })
      }
    })()
    // Renewal reminders — DM customers ~7 days before their monthly/annual
    // license expires.
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        startRenewalReminders()
      } catch (err) {
        log.warn("failed to start renewal reminders", { error: err instanceof Error ? err.message : String(err) })
        captureException(err, { tags: { surface: "reminders-init" } })
      }
    }

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
