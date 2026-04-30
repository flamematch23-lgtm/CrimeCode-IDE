/**
 * Whisper bridging — `/v1/audio/transcriptions` and
 * `/v1/audio/translations` endpoints, OpenAI-compatible.
 *
 * The actual STT happens in an upstream Whisper-flavoured server. We
 * support three back-ends interchangeably:
 *
 *   1. faster-whisper-server  (https://github.com/fedirz/faster-whisper-server)
 *      — already exposes /v1/audio/transcriptions, we just forward.
 *
 *   2. whisper.cpp `server`   (built-in HTTP API, OpenAI-compatible
 *      since v1.6.0)
 *
 *   3. localai                (drop-in OpenAI replacement)
 *
 * All three speak the same OpenAI multipart form: { file, model,
 * response_format, temperature?, language?, prompt? }. We forward the
 * raw FormData transparently so future fields don't need code changes.
 *
 * Configuration:
 *   WHISPER_URL       default http://127.0.0.1:9000
 *   WHISPER_API_KEY   optional Bearer for the upstream
 *   WHISPER_MODEL_DEFAULT  fallback model id when client doesn't send one
 */
import { Hono } from "hono"
import { emitWebhook } from "./webhooks.ts"
import { getDb } from "./db.ts"
import type { AuthContext } from "./auth.ts"

const WHISPER_URL = (process.env.WHISPER_URL ?? "http://127.0.0.1:9000").replace(/\/+$/, "")
const WHISPER_API_KEY = process.env.WHISPER_API_KEY ?? ""
const WHISPER_MODEL_DEFAULT = process.env.WHISPER_MODEL_DEFAULT ?? "whisper-1"

export function audioRouter() {
  const r = new Hono<{ Variables: { auth: AuthContext } }>()

  r.post("/transcriptions", (c) => bridgeWhisper(c, "transcriptions"))
  r.post("/translations", (c) => bridgeWhisper(c, "translations"))
  return r
}

async function bridgeWhisper(
  c: import("hono").Context<{ Variables: { auth: AuthContext } }>,
  kind: "transcriptions" | "translations",
) {
  const startedAt = Date.now()
  const auth = c.get("auth")
  if (!auth.scopes.has("audio")) return c.json({ error: { message: "scope_missing:audio", type: "auth" } }, 403)

  // Read the multipart form once so we can inspect + forward.
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: { message: "bad multipart body", type: "request" } }, 400)
  }

  // The OpenAI spec says `file` is required.
  const file = formData.get("file")
  if (!file || !(file instanceof File)) {
    return c.json({ error: { message: "missing 'file' field", type: "request" } }, 400)
  }

  // Default model if the client didn't send one.
  if (!formData.get("model")) formData.set("model", WHISPER_MODEL_DEFAULT)
  const modelName = String(formData.get("model"))

  // Forward to the Whisper server, preserving the multipart body.
  const headers: Record<string, string> = {}
  if (WHISPER_API_KEY) headers["Authorization"] = `Bearer ${WHISPER_API_KEY}`

  let upstream: Response
  try {
    upstream = await fetch(`${WHISPER_URL}/v1/audio/${kind}`, {
      method: "POST",
      headers,
      body: formData,
    })
  } catch (e) {
    const msg = (e as Error).message
    emitWebhook("audio.error", { kind, model: modelName, error: msg, key_label: auth.label })
    logAudio({ ctx: auth, status: 502, latencyMs: Date.now() - startedAt, model: modelName, error: msg })
    return c.json({ error: { message: `whisper unreachable: ${msg}`, type: "upstream" } }, 502)
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "")
    emitWebhook("audio.error", { kind, model: modelName, status: upstream.status, body: txt.slice(0, 300), key_label: auth.label })
    logAudio({ ctx: auth, status: upstream.status, latencyMs: Date.now() - startedAt, model: modelName, error: txt.slice(0, 200) })
    return c.json(
      { error: { message: `whisper error ${upstream.status}: ${txt.slice(0, 200)}`, type: "upstream" } },
      502,
    )
  }

  // Forward the upstream response as-is (json or text depending on
  // response_format). Preserve content-type so streaming verbose JSON
  // works.
  const contentType = upstream.headers.get("content-type") ?? "application/json"
  const buf = await upstream.arrayBuffer()
  logAudio({ ctx: auth, status: 200, latencyMs: Date.now() - startedAt, model: modelName, bytes: buf.byteLength })
  return new Response(buf, { status: 200, headers: { "Content-Type": contentType } })
}

function logAudio(args: {
  ctx: AuthContext
  status: number
  latencyMs: number
  model: string
  bytes?: number
  error?: string
}) {
  try {
    getDb().run(
      `INSERT INTO usage (ts, key_label, ip, model, endpoint, status, prompt_tokens, completion_tokens, latency_ms, error)
       VALUES (?, ?, ?, ?, '/v1/audio', ?, NULL, NULL, ?, ?)`,
      [Date.now(), args.ctx.label, "audio", args.model, args.status, args.latencyMs, args.error ?? null],
    )
  } catch {
    /* best-effort */
  }
}
