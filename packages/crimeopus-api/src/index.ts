#!/usr/bin/env bun
/**
 * CrimeOpus API — self-hosted OpenAI-compatible gateway.
 *
 * Endpoints:
 *   GET  /v1/models                       (auth, scope: models:list)
 *   POST /v1/chat/completions             (auth, scope: chat, quota tracked)
 *   POST /v1/embeddings                   (auth, scope: embed, quota tracked)
 *   POST /v1/audio/transcriptions         (auth, scope: audio, quota tracked)
 *   POST /v1/audio/translations           (auth, scope: audio, quota tracked)
 *   GET  /healthz                         (no auth)
 *   GET  /admin                           (basic auth — ADMIN_PASSWORD)
 *   *    /admin/api/*                     (basic auth — ADMIN_PASSWORD)
 *
 * Auth:
 *   - Static API keys via env API_KEYS or via /admin
 *   - JWT bearer (HS256 / RS256) — auto-onboards new tenants
 *   - Per-key scopes: models:list, chat, embed, audio
 *
 * Quotas:
 *   - Per-key monthly token + request counters with auto rollover at
 *     UTC month start
 *   - Webhook 'quota.warning' at 80%, 'quota.exceeded' at 100% (block)
 *
 * See README.md for deployment recipes.
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { stream } from "hono/streaming"
import { getDb } from "./db.ts"
import { syncEnvApiKeys, resolveAuth, type AuthContext } from "./auth.ts"
import { checkQuota, recordUsage } from "./quota.ts"
import { emitWebhook } from "./webhooks.ts"
import { audioRouter } from "./audio.ts"
import { adminRouter } from "./admin.ts"
import { licenseRouter } from "./license-routes.ts"
import { runMigrations } from "./migrations.ts"
import { getLicenseDb } from "./license-auth.ts"
import { mountUserRoutes } from "./routes/user.ts"
import { join } from "node:path"
import {
  acquireSlot,
  buildUpstreamFetch,
  startHealthChecks,
  UpstreamError,
  listPublicModels,
  getCatalogEntry,
  catalog,
} from "./upstream.ts"

// ─── Config ───────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8787)
const BIND = process.env.BIND ?? "0.0.0.0"
const ALLOW_ANON = process.env.ALLOW_ANON === "1"
const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 60)
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST ?? 10)
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim())
// Hard ceiling for a single upstream chat/embed call — without this, a
// hung provider (RunPod cold start that never finishes loading a 35B
// model, network blip, etc.) keeps the slot reserved indefinitely and
// every subsequent request from that key gets `per_key_concurrency_
// exceeded` until the gateway is restarted. 5 minutes is generous enough
// for legitimate cold starts but short enough that a real hang recovers
// on its own.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 5 * 60_000)

// Boot: open the DB so the schema is in place, then sync env keys
// and start the upstream health-check loop.
getDb()
syncEnvApiKeys()
startHealthChecks()

// Apply license DB migrations idempotently before serving traffic.
{
  const migrationsDir = join(import.meta.dir, "..", "migrations")
  const applied = runMigrations(getLicenseDb(), migrationsDir)
  if (applied.length > 0) {
    console.log(`✓ Applied ${applied.length} migration(s): ${applied.join(", ")}`)
  }
}

// ─── Rate limit (token bucket per key) ─────────────────────────────────

interface Bucket {
  tokens: number
  lastRefill: number
}
const buckets = new Map<string, Bucket>()

function takeToken(keyId: string, rpm: number): boolean {
  const now = Date.now()
  const ratePerMs = rpm / 60_000
  let b = buckets.get(keyId)
  if (!b) {
    b = { tokens: RATE_LIMIT_BURST, lastRefill: now }
    buckets.set(keyId, b)
  }
  const elapsed = now - b.lastRefill
  b.tokens = Math.min(RATE_LIMIT_BURST, b.tokens + elapsed * ratePerMs)
  b.lastRefill = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

// ─── Usage log helper (for non-quota endpoints) ────────────────────────

function logUsage(args: {
  keyLabel: string | null
  ip: string
  model: string | null
  endpoint: string
  status: number
  promptTokens?: number
  completionTokens?: number
  latencyMs: number
  error?: string
}) {
  try {
    getDb().run(
      `INSERT INTO usage (ts, key_label, ip, model, endpoint, status, prompt_tokens, completion_tokens, latency_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now(),
        args.keyLabel,
        args.ip,
        args.model,
        args.endpoint,
        args.status,
        args.promptTokens ?? null,
        args.completionTokens ?? null,
        args.latencyMs,
        args.error ?? null,
      ],
    )
  } catch {
    /* logging is best-effort */
  }
}

// ─── Hono app ──────────────────────────────────────────────────────────

const app = new Hono<{ Variables: { auth: AuthContext } }>()

app.use("*", cors({ origin: CORS_ORIGINS, allowHeaders: ["Authorization", "Content-Type"] }))

// Mount admin BEFORE the auth middleware so it can do its own basic-auth.
app.route("/admin", adminRouter())

// Mount license auth routes (public, no auth required)
app.route("/license", licenseRouter())

// Mount user dashboard API routes (session-cookie auth)
mountUserRoutes(app, { licenseDb: getLicenseDb(), usageDb: getDb() })

// Public health
app.get("/healthz", (c) => {
  // Healthcheck loop in upstream.ts already pings every 30s. Just
  // report the current snapshot.
  return c.json({ ok: true, version: "0.3.0" })
})

app.get("/", (c) =>
  c.json({
    name: "CrimeOpus API",
    version: "0.2.0",
    endpoints: [
      "/v1/models",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/audio/transcriptions",
      "/v1/audio/translations",
      "/admin",
      "/healthz",
    ],
  }),
)

// ─── Auth middleware for /v1/* ────────────────────────────────────────

app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "").trim()

  if (!token && !ALLOW_ANON) return c.json({ error: { message: "missing api key", type: "auth" } }, 401)

  let ctx: AuthContext | null = null
  if (token) {
    const resolved = resolveAuth(token)
    if ("error" in resolved) {
      if (!ALLOW_ANON) return c.json({ error: { message: resolved.error, type: "auth" } }, 401)
    } else {
      ctx = resolved
    }
  }

  if (!ctx && ALLOW_ANON) {
    // Synthetic anonymous context (NEVER use in prod). Quotas are skipped.
    ctx = {
      keyId: 0,
      kind: "static",
      label: "anonymous",
      tenantId: null,
      rpm: null,
      monthlyTokenQuota: null,
      monthlyRequestQuota: null,
      scopes: new Set(["models:list", "chat", "embed", "audio"]),
    }
  }
  if (!ctx) return c.json({ error: { message: "auth_failed", type: "auth" } }, 401)

  // Rate limit (token bucket, per key)
  const rpm = ctx.rpm ?? RATE_LIMIT_RPM
  const bucketKey = ctx.label
  if (!takeToken(bucketKey, rpm)) {
    emitWebhook("ratelimit.exceeded", { key_label: ctx.label, rpm, ip: ipOf(c) })
    return c.json({ error: { message: "rate_limit_exceeded", type: "rate_limit" } }, 429)
  }
  c.set("auth", ctx)
  await next()
})

function ipOf(c: { req: { header: (n: string) => string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for")
  return (
    c.req.header("cf-connecting-ip") ??
    (xff ? xff.split(",")[0]!.trim() : null) ??
    c.req.header("x-real-ip") ??
    "unknown"
  )
}

function requireScope(c: import("hono").Context<{ Variables: { auth: AuthContext } }>, scope: string) {
  const auth = c.get("auth")
  if (!auth.scopes.has(scope)) {
    return c.json({ error: { message: `scope_missing:${scope}`, type: "auth" } }, 403)
  }
  return null
}

// ─── /v1/models ────────────────────────────────────────────────────────

app.get("/v1/models", (c) => {
  const t0 = Date.now()
  const auth = c.get("auth")
  const scopeFail = requireScope(c, "models:list")
  if (scopeFail) return scopeFail
  const ip = ipOf(c)
  const data = listPublicModels().map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "crimeopus",
    display: m.display,
    description: m.description,
  }))
  logUsage({ keyLabel: auth.label, ip, model: null, endpoint: "/v1/models", status: 200, latencyMs: Date.now() - t0 })
  return c.json({ object: "list", data })
})

// ─── /v1/chat/completions ──────────────────────────────────────────────

interface ChatBody {
  model: string
  messages: Array<{ role: string; content: string | unknown }>
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
  tools?: unknown
  tool_choice?: unknown
  response_format?: unknown
  user?: string
}

app.post("/v1/chat/completions", async (c) => {
  const startedAt = Date.now()
  const auth = c.get("auth")
  const scopeFail = requireScope(c, "chat")
  if (scopeFail) return scopeFail
  const ip = ipOf(c)

  // Quota check (pre-flight)
  const q = checkQuota(auth)
  if (!q.allowed) {
    return c.json({ error: { message: `quota_exceeded: ${q.reason} for period ${q.period}`, type: "quota" } }, 429)
  }

  let body: ChatBody
  try {
    body = (await c.req.json()) as ChatBody
  } catch {
    logUsage({
      keyLabel: auth.label,
      ip,
      model: null,
      endpoint: "/v1/chat/completions",
      status: 400,
      latencyMs: 0,
      error: "bad json",
    })
    return c.json({ error: { message: "invalid json body", type: "request" } }, 400)
  }
  if (!body.model || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "missing model or messages", type: "request" } }, 400)
  }

  // Reserve a slot on the upstream provider pool. acquireSlot picks the
  // first healthy provider in the catalog's failover list with a free slot.
  let slot
  try {
    slot = await acquireSlot(body.model, auth.label)
  } catch (e) {
    const err = e as UpstreamError
    logUsage({
      keyLabel: auth.label,
      ip,
      model: body.model,
      endpoint: "/v1/chat/completions",
      status: err.httpStatus ?? 503,
      latencyMs: Date.now() - startedAt,
      error: err.code,
    })
    return c.json({ error: { message: err.code, type: "upstream" } }, (err.httpStatus ?? 503) as 503)
  }

  // Apply system prompt prefix from catalog (if any).
  const entry = getCatalogEntry(body.model)
  if (entry?.systemPrefix) {
    const first = body.messages[0]
    if (first && first.role === "system" && typeof first.content === "string") {
      body.messages[0] = { role: "system", content: entry.systemPrefix + "\n\n" + first.content }
    } else {
      body.messages = [{ role: "system", content: entry.systemPrefix }, ...body.messages]
    }
  }

  const upstreamBody = { ...body, model: slot.upstreamModel }
  const isStream = body.stream === true
  const release = slot.release
  const { url, headers } = buildUpstreamFetch(slot.provider, "/v1/chat/completions")

  let upstreamResp: Response
  try {
    upstreamResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(upstreamBody),
      // Bounded timeout so the slot can never leak forever — see
      // UPSTREAM_TIMEOUT_MS comment near the top of this file.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    release()
    const msg = (e as Error).message
    emitWebhook("upstream.error", { provider: slot.provider.id, model: body.model, error: msg })
    logUsage({
      keyLabel: auth.label,
      ip,
      model: body.model,
      endpoint: "/v1/chat/completions",
      status: 502,
      latencyMs: Date.now() - startedAt,
      error: msg,
    })
    return c.json({ error: { message: `upstream unreachable: ${msg}`, type: "upstream" } }, 502)
  }

  if (!upstreamResp.ok) {
    release()
    const txt = await upstreamResp.text().catch(() => "")
    emitWebhook("upstream.error", { endpoint: "/v1/chat/completions", model: body.model, status: upstreamResp.status })
    logUsage({
      keyLabel: auth.label,
      ip,
      model: body.model,
      endpoint: "/v1/chat/completions",
      status: upstreamResp.status,
      latencyMs: Date.now() - startedAt,
      error: txt.slice(0, 500),
    })
    return c.json(
      { error: { message: `upstream error: ${upstreamResp.status} ${txt.slice(0, 200)}`, type: "upstream" } },
      502,
    )
  }

  if (!isStream) {
    try {
      const json = (await upstreamResp.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        [k: string]: unknown
      }
      if (typeof (json as { model?: string }).model === "string") (json as { model: string }).model = body.model
      const promptTokens = json.usage?.prompt_tokens ?? 0
      const completionTokens = json.usage?.completion_tokens ?? 0
      recordUsage({ ctx: auth, promptTokens, completionTokens })
      logUsage({
        keyLabel: auth.label,
        ip,
        model: body.model,
        endpoint: "/v1/chat/completions",
        status: 200,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - startedAt,
      })
      return c.json(json)
    } finally {
      release()
    }
  }

  // Streaming SSE pipe-through with model rewrite + post-stream usage
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache")
  c.header("Connection", "keep-alive")
  return stream(c, async (s) => {
    const reader = upstreamResp.body!.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buf = ""
    let promptTokens = 0
    let completionTokens = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (frame.startsWith("data: ")) {
            const data = frame.slice(6).trim()
            if (data === "[DONE]") {
              await s.write(encoder.encode(frame + "\n\n"))
              continue
            }
            try {
              const parsed = JSON.parse(data) as {
                model?: string
                usage?: { prompt_tokens?: number; completion_tokens?: number }
              }
              if (parsed.model) parsed.model = body.model
              if (parsed.usage?.prompt_tokens) promptTokens = parsed.usage.prompt_tokens
              if (parsed.usage?.completion_tokens) completionTokens = parsed.usage.completion_tokens
              await s.write(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
            } catch {
              await s.write(encoder.encode(frame + "\n\n"))
            }
          } else {
            await s.write(encoder.encode(frame + "\n\n"))
          }
        }
      }
    } finally {
      release()
      recordUsage({ ctx: auth, promptTokens, completionTokens })
      logUsage({
        keyLabel: auth.label,
        ip,
        model: body.model,
        endpoint: "/v1/chat/completions",
        status: 200,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - startedAt,
      })
    }
  })
})

// ─── /v1/embeddings ────────────────────────────────────────────────────

app.post("/v1/embeddings", async (c) => {
  const startedAt = Date.now()
  const auth = c.get("auth")
  const scopeFail = requireScope(c, "embed")
  if (scopeFail) return scopeFail
  const ip = ipOf(c)

  const q = checkQuota(auth)
  if (!q.allowed) return c.json({ error: { message: `quota_exceeded: ${q.reason}`, type: "quota" } }, 429)

  const body = (await c.req.json().catch(() => ({}))) as { model?: string; input?: string | string[] }
  if (!body.model || body.input === undefined) {
    return c.json({ error: { message: "missing model or input", type: "request" } }, 400)
  }
  let slot
  try {
    slot = await acquireSlot(body.model, auth.label)
  } catch (e) {
    const err = e as UpstreamError
    return c.json({ error: { message: err.code, type: "upstream" } }, (err.httpStatus ?? 503) as 503)
  }
  const { url, headers } = buildUpstreamFetch(slot.provider, "/v1/embeddings")
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: slot.upstreamModel, input: body.input }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => "")
      emitWebhook("upstream.error", { provider: slot.provider.id, endpoint: "/v1/embeddings", status: r.status })
      logUsage({
        keyLabel: auth.label,
        ip,
        model: body.model,
        endpoint: "/v1/embeddings",
        status: r.status,
        latencyMs: Date.now() - startedAt,
        error: t.slice(0, 200),
      })
      return c.json({ error: { message: `upstream error: ${r.status}`, type: "upstream" } }, 502)
    }
    const json = (await r.json()) as { model?: string; usage?: { prompt_tokens?: number } }
    if (json.model) json.model = body.model
    const promptTokens = json.usage?.prompt_tokens ?? 0
    recordUsage({ ctx: auth, promptTokens, completionTokens: 0 })
    logUsage({
      keyLabel: auth.label,
      ip,
      model: body.model,
      endpoint: "/v1/embeddings",
      status: 200,
      promptTokens,
      latencyMs: Date.now() - startedAt,
    })
    return c.json(json)
  } catch (e) {
    const err = (e as Error).message
    emitWebhook("upstream.error", { provider: slot.provider.id, error: err })
    return c.json({ error: { message: `upstream unreachable: ${err}`, type: "upstream" } }, 502)
  } finally {
    slot.release()
  }
})

// ─── /v1/audio/* (Whisper bridging) ────────────────────────────────────

app.route("/v1/audio", audioRouter())

// ─── /v1/sandbox/run — isolated code execution ─────────────────────────
// Spawns a one-shot Docker container (default backend) with strict
// resource limits, no network, and read-only root FS. Returns stdout +
// stderr + exit code. Languages: python, node, bash. Auth scope:
// "sandbox". See ./sandbox.ts for backend selection (docker | e2b).

import { runSandbox, isSupportedLanguage, ensureImagesAvailable, type SandboxLanguage } from "./sandbox.ts"

app.post("/v1/sandbox/run", async (c) => {
  const t0 = Date.now()
  const auth = c.get("auth")
  const scopeFail = requireScope(c, "sandbox")
  if (scopeFail) return scopeFail
  const ip = ipOf(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    language?: string
    code?: string
    timeout_ms?: number
  }
  if (typeof body.language !== "string" || typeof body.code !== "string") {
    return c.json({ error: { message: "missing language or code", type: "bad_request" } }, 400)
  }
  if (!isSupportedLanguage(body.language)) {
    return c.json(
      { error: { message: `unsupported language: ${body.language}. Use python, node, or bash.`, type: "bad_request" } },
      400,
    )
  }
  try {
    const result = await runSandbox({
      language: body.language as SandboxLanguage,
      code: body.code,
      timeout_ms: typeof body.timeout_ms === "number" ? body.timeout_ms : undefined,
    })
    logUsage({
      keyLabel: auth.label,
      ip,
      model: null,
      endpoint: "/v1/sandbox/run",
      status: 200,
      latencyMs: Date.now() - t0,
    })
    return c.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logUsage({
      keyLabel: auth.label,
      ip,
      model: null,
      endpoint: "/v1/sandbox/run",
      status: 400,
      latencyMs: Date.now() - t0,
    })
    return c.json({ error: { message: msg, type: "sandbox" } }, 400)
  }
})

// Pre-warm Docker images on boot so the first request doesn't pay the
// pull cost (~30 s for python:3.12-slim). Does nothing on E2B backend.
void ensureImagesAvailable()

// ─── Boot ──────────────────────────────────────────────────────────────

const keyCount = (getDb().query("SELECT COUNT(*) AS c FROM keys WHERE disabled = 0").get() as { c: number }).c
const { providers } = await import("./upstream.ts")
console.log(`✓ CrimeOpus API listening on http://${BIND}:${PORT}`)
console.log(`  upstream providers: ${providers.length}`)
for (const p of providers) {
  console.log(`    - ${p.id} (${p.kind}) → ${p.url}  slots:${p.maxInflight}  weight:${p.weight}`)
}
console.log(`  catalog: ${catalog.size} model(s)`)
console.log(`  upstream Whisper: ${process.env.WHISPER_URL ?? "http://127.0.0.1:9000"}`)
console.log(`  active keys: ${keyCount}${ALLOW_ANON ? " (+ anonymous allowed)" : ""}`)
console.log(`  rate limit: ${RATE_LIMIT_RPM} rpm / burst ${RATE_LIMIT_BURST}`)
console.log(`  per-key concurrency: ${process.env.PER_KEY_CONCURRENCY ?? "2"}`)
console.log(`  queue: max ${process.env.QUEUE_MAX ?? "50"}, timeout ${process.env.QUEUE_TIMEOUT_MS ?? "30000"}ms`)
console.log(`  usage log: ${process.env.LOG_DB ?? "./usage.db"}`)
console.log(`  admin dashboard: ${process.env.ADMIN_PASSWORD ? "enabled at /admin" : "DISABLED (set ADMIN_PASSWORD)"}`)
console.log(`  jwt: ${process.env.JWT_SECRET ? "HS256" : process.env.JWT_PUBLIC_KEY ? "RS256" : "disabled"}`)

if ((process.env.API_KEYS ?? "") === "" && keyCount === 0 && !ALLOW_ANON) {
  console.error(
    "✗ No API keys configured AND no admin keys in DB AND ALLOW_ANON not set.\n" +
      "  Set API_KEYS env, or boot with ADMIN_PASSWORD and create keys via /admin, or ALLOW_ANON=1 (DEV ONLY).",
  )
  process.exit(2)
}

export default {
  port: PORT,
  hostname: BIND,
  fetch: app.fetch,
  // Bigger upload limit for audio files (default Bun = 64 MB; bump to 256)
  maxRequestBodySize: 256 * 1024 * 1024,
}
