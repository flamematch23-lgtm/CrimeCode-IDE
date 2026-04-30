#!/usr/bin/env bun
/**
 * CrimeOpus API — self-hosted OpenAI-compatible gateway.
 *
 * One-file Bun + Hono server that exposes the OpenAI Chat Completions
 * surface (`/v1/models`, `/v1/chat/completions`, `/v1/embeddings`) and
 * proxies all calls to a local or remote Ollama instance.
 *
 * Add it to OpenCode (or any OpenAI SDK client) like a normal cloud
 * provider:
 *
 *   {
 *     "provider": {
 *       "crimeopus": {
 *         "name": "CrimeOpus Cloud",
 *         "npm": "@ai-sdk/openai-compatible",
 *         "options": {
 *           "baseURL": "https://api.your-domain.tld/v1",
 *           "apiKey": "{env:CRIMEOPUS_API_KEY}"
 *         },
 *         "models": { … }
 *       }
 *     }
 *   }
 *
 * Features:
 *   - API-key auth (multiple keys, per-key rate limit + label for logs)
 *   - Per-key + per-IP rate limit (token bucket, no Redis needed)
 *   - Usage logging to SQLite (one row per request: ts, key_label, model,
 *     tokens, latency, status, ip)
 *   - Custom catalog: rename / hide / alias Ollama models so the public
 *     name doesn't leak the underlying file (e.g. show "CrimeOpus 4.7"
 *     instead of "hf.co/mradermacher/...:IQ4_XS")
 *   - Streaming + non-streaming chat completions
 *   - CORS configurable
 *   - /healthz endpoint for load balancers
 *   - Graceful upstream-down handling with descriptive error messages
 *
 * Configuration is via environment variables (.env or shell):
 *
 *   PORT             default 8787
 *   BIND             default 0.0.0.0
 *   OLLAMA_URL       default http://127.0.0.1:11434
 *   API_KEYS         JSON object: {"sk-prod-abc":"label","sk-dev":"…"}
 *                    OR comma-separated keys: "sk-1,sk-2,sk-3"
 *   ALLOW_ANON       set to "1" to skip auth (dev only — DO NOT in prod)
 *   RATE_LIMIT_RPM   default 60 requests/minute per key
 *   RATE_LIMIT_BURST default 10 (token bucket size)
 *   CORS_ORIGINS     comma-separated origins or "*" (default "*")
 *   LOG_DB           SQLite path for usage logs (default ./usage.db)
 *   CATALOG_PATH     path to a JSON file mapping public model id →
 *                    upstream Ollama model id (see catalog.example.json).
 *                    If absent, every Ollama model is exposed as-is.
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { stream } from "hono/streaming"
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"

// ─── Config ───────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8787)
const BIND = process.env.BIND ?? "0.0.0.0"
const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "")
const ALLOW_ANON = process.env.ALLOW_ANON === "1"
const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 60)
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST ?? 10)
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim())
const LOG_DB = process.env.LOG_DB ?? "./usage.db"
const CATALOG_PATH = process.env.CATALOG_PATH ?? "./catalog.json"

interface KeyEntry {
  label: string
  rpmOverride?: number
}

const apiKeys: Map<string, KeyEntry> = (() => {
  const raw = process.env.API_KEYS ?? ""
  const m = new Map<string, KeyEntry>()
  if (!raw) return m
  // Try JSON first
  try {
    const obj = JSON.parse(raw) as Record<string, string | { label: string; rpm?: number }>
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") m.set(k, { label: v })
      else m.set(k, { label: v.label, rpmOverride: v.rpm })
    }
    return m
  } catch {
    /* not JSON — fall through to CSV */
  }
  for (const k of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    m.set(k, { label: k.slice(0, 12) })
  }
  return m
})()

if (apiKeys.size === 0 && !ALLOW_ANON) {
  console.error(
    "✗ API_KEYS is empty and ALLOW_ANON is not set. The server would refuse every request.\n" +
      "  Set API_KEYS='sk-yourkey:label' or ALLOW_ANON=1 (DEV ONLY).",
  )
  process.exit(2)
}

// ─── Catalog: public model id → upstream Ollama tag ────────────────────

interface CatalogEntry {
  /** Upstream Ollama tag, e.g. "crimeopus-default:latest" */
  upstream: string
  /** What to display in /v1/models */
  display?: string
  description?: string
  /** Hide from /v1/models but still callable by id */
  hidden?: boolean
  /** Override max context the client can request (default Ollama default) */
  maxContext?: number
  /** Inject a system prompt prefix on every call */
  systemPrefix?: string
}

const catalog: Map<string, CatalogEntry> = (() => {
  const m = new Map<string, CatalogEntry>()
  if (!existsSync(CATALOG_PATH)) {
    console.warn(`ℹ no catalog at ${CATALOG_PATH} — passing all Ollama models through unchanged`)
    return m
  }
  try {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Record<string, CatalogEntry>
    for (const [id, e] of Object.entries(raw)) m.set(id, e)
    console.log(`✓ loaded catalog with ${m.size} model(s) from ${CATALOG_PATH}`)
    return m
  } catch (e) {
    console.error(`✗ failed to parse catalog ${CATALOG_PATH}: ${(e as Error).message}`)
    return m
  }
})()

function resolveUpstream(publicId: string): { upstreamId: string; entry: CatalogEntry | null } {
  const entry = catalog.get(publicId) ?? null
  if (entry) return { upstreamId: entry.upstream, entry }
  return { upstreamId: publicId, entry: null }
}

// ─── Usage log (sqlite) ────────────────────────────────────────────────

const db = new Database(LOG_DB)
db.exec(`
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_label TEXT,
  ip TEXT,
  model TEXT,
  endpoint TEXT,
  status INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage(key_label);
`)

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
    db.run(
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
  // Refill since last hit
  const elapsed = now - b.lastRefill
  b.tokens = Math.min(RATE_LIMIT_BURST, b.tokens + elapsed * ratePerMs)
  b.lastRefill = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

// ─── Hono app ──────────────────────────────────────────────────────────

const app = new Hono()

app.use("*", cors({ origin: CORS_ORIGINS, allowHeaders: ["Authorization", "Content-Type"] }))

// Auth middleware — runs on every /v1/* route
app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  let keyEntry: KeyEntry | null = null
  if (apiKeys.size > 0) {
    const found = apiKeys.get(token)
    if (!found) {
      if (!ALLOW_ANON) return c.json({ error: { message: "invalid api key", type: "auth" } }, 401)
    } else {
      keyEntry = found
    }
  }
  const rpm = keyEntry?.rpmOverride ?? RATE_LIMIT_RPM
  const bucketKey = keyEntry?.label ?? ipOf(c)
  if (!takeToken(bucketKey, rpm)) {
    return c.json({ error: { message: "rate_limit_exceeded", type: "rate_limit" } }, 429)
  }
  c.set("keyLabel", keyEntry?.label ?? null)
  await next()
})

function ipOf(c: { req: { header: (n: string) => string | undefined; raw?: { headers?: Headers } } }): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  )
}

// ─── /v1/models ────────────────────────────────────────────────────────

app.get("/v1/models", async (c) => {
  const t0 = Date.now()
  const keyLabel = c.get("keyLabel" as never) as string | null
  const ip = ipOf(c)
  // If a catalog is configured, return ONLY catalog entries (minus hidden).
  if (catalog.size > 0) {
    const data = [...catalog.entries()]
      .filter(([, e]) => !e.hidden)
      .map(([id, e]) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "crimeopus",
        display: e.display ?? id,
        description: e.description,
      }))
    logUsage({ keyLabel, ip, model: null, endpoint: "/v1/models", status: 200, latencyMs: Date.now() - t0 })
    return c.json({ object: "list", data })
  }
  // Otherwise mirror what Ollama has installed.
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`)
    const body = (await r.json()) as { models?: Array<{ name: string; size?: number; modified_at?: string }> }
    const data = (body.models ?? []).map((m) => ({
      id: m.name,
      object: "model",
      created: m.modified_at ? Math.floor(new Date(m.modified_at).getTime() / 1000) : 0,
      owned_by: "ollama",
    }))
    logUsage({ keyLabel, ip, model: null, endpoint: "/v1/models", status: 200, latencyMs: Date.now() - t0 })
    return c.json({ object: "list", data })
  } catch (e) {
    const err = (e as Error).message
    logUsage({ keyLabel, ip, model: null, endpoint: "/v1/models", status: 502, latencyMs: Date.now() - t0, error: err })
    return c.json({ error: { message: `upstream Ollama unavailable: ${err}`, type: "upstream" } }, 502)
  }
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
  const keyLabel = c.get("keyLabel" as never) as string | null
  const ip = ipOf(c)
  let body: ChatBody
  try {
    body = (await c.req.json()) as ChatBody
  } catch {
    logUsage({ keyLabel, ip, model: null, endpoint: "/v1/chat/completions", status: 400, latencyMs: 0, error: "bad json" })
    return c.json({ error: { message: "invalid json body", type: "request" } }, 400)
  }
  if (!body.model || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "missing model or messages", type: "request" } }, 400)
  }

  const { upstreamId, entry } = resolveUpstream(body.model)

  // Optional system-prompt prefix injection from catalog
  if (entry?.systemPrefix) {
    const first = body.messages[0]
    if (first?.role === "system" && typeof first.content === "string") {
      body.messages[0] = { role: "system", content: entry.systemPrefix + "\n\n" + first.content }
    } else {
      body.messages = [{ role: "system", content: entry.systemPrefix }, ...body.messages]
    }
  }

  // Forward to Ollama OpenAI-compatible endpoint
  const upstreamBody = { ...body, model: upstreamId }
  const isStream = body.stream === true
  let upstreamResp: Response
  try {
    upstreamResp = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
    })
  } catch (e) {
    const msg = (e as Error).message
    logUsage({ keyLabel, ip, model: body.model, endpoint: "/v1/chat/completions", status: 502, latencyMs: Date.now() - startedAt, error: msg })
    return c.json({ error: { message: `upstream Ollama unreachable: ${msg}`, type: "upstream" } }, 502)
  }

  if (!upstreamResp.ok) {
    const txt = await upstreamResp.text().catch(() => "")
    logUsage({
      keyLabel,
      ip,
      model: body.model,
      endpoint: "/v1/chat/completions",
      status: upstreamResp.status,
      latencyMs: Date.now() - startedAt,
      error: txt.slice(0, 500),
    })
    return c.json({ error: { message: `upstream error: ${upstreamResp.status} ${txt.slice(0, 200)}`, type: "upstream" } }, 502)
  }

  if (!isStream) {
    const json = (await upstreamResp.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      [k: string]: unknown
    }
    // Rewrite model id back to public id so clients see the public name
    if (typeof (json as { model?: string }).model === "string") {
      ;(json as { model: string }).model = body.model
    }
    logUsage({
      keyLabel,
      ip,
      model: body.model,
      endpoint: "/v1/chat/completions",
      status: 200,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      latencyMs: Date.now() - startedAt,
    })
    return c.json(json)
  }

  // Streaming SSE — pipe through, rewriting `model` field on each frame.
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
      logUsage({
        keyLabel,
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
  const keyLabel = c.get("keyLabel" as never) as string | null
  const ip = ipOf(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    model?: string
    input?: string | string[]
  }
  if (!body.model || body.input === undefined) {
    return c.json({ error: { message: "missing model or input", type: "request" } }, 400)
  }
  const { upstreamId } = resolveUpstream(body.model)
  try {
    const r = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: upstreamId, input: body.input }),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => "")
      logUsage({
        keyLabel,
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
    logUsage({
      keyLabel,
      ip,
      model: body.model,
      endpoint: "/v1/embeddings",
      status: 200,
      promptTokens: json.usage?.prompt_tokens,
      latencyMs: Date.now() - startedAt,
    })
    return c.json(json)
  } catch (e) {
    return c.json({ error: { message: `upstream unreachable: ${(e as Error).message}`, type: "upstream" } }, 502)
  }
})

// ─── Health + admin ────────────────────────────────────────────────────

app.get("/healthz", async (c) => {
  let upstreamOk = false
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
    upstreamOk = r.ok
  } catch {
    /* down */
  }
  return c.json({ ok: true, upstream: upstreamOk, version: "0.1.0" })
})

app.get("/", (c) =>
  c.json({
    name: "CrimeOpus API",
    version: "0.1.0",
    endpoints: ["/v1/models", "/v1/chat/completions", "/v1/embeddings", "/healthz"],
  }),
)

// ─── Boot ──────────────────────────────────────────────────────────────

console.log(`✓ CrimeOpus API listening on http://${BIND}:${PORT}`)
console.log(`  upstream Ollama: ${OLLAMA_URL}`)
console.log(`  api keys configured: ${apiKeys.size}${ALLOW_ANON ? " (anonymous allowed)" : ""}`)
console.log(`  rate limit: ${RATE_LIMIT_RPM} rpm / burst ${RATE_LIMIT_BURST}`)
console.log(`  catalog: ${catalog.size} model(s)`)
console.log(`  usage log: ${LOG_DB}`)

export default {
  port: PORT,
  hostname: BIND,
  fetch: app.fetch,
}
