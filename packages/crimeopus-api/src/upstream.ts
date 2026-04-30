/**
 * Upstream provider abstraction.
 *
 * The gateway is no longer tied to a local Ollama. Pick any combination
 * of OpenAI-compatible cloud providers via the UPSTREAM_PROVIDERS env
 * var:
 *
 *   UPSTREAM_PROVIDERS='[
 *     { "id": "together",   "kind": "openai",  "url": "https://api.together.xyz/v1", "apiKey": "togetherKey", "weight": 3 },
 *     { "id": "fireworks",  "kind": "openai",  "url": "https://api.fireworks.ai/inference/v1", "apiKey": "fwKey", "weight": 2 },
 *     { "id": "openrouter", "kind": "openai",  "url": "https://openrouter.ai/api/v1", "apiKey": "orKey", "weight": 1 },
 *     { "id": "runpod-1",   "kind": "openai",  "url": "https://api.runpod.ai/v2/<endpointId>/openai/v1", "apiKey": "rpKey" },
 *     { "id": "ollama-dev", "kind": "ollama",  "url": "http://127.0.0.1:11434", "weight": 0 }
 *   ]'
 *
 * Each provider has its own concurrency cap so a single slow upstream
 * can't backpressure the whole router.
 *
 * Model resolution: catalog.json now associates each public model id
 * with a `provider_id` and `provider_model`. A single public name like
 * `crimeopus-default` can have multiple providers as failover.
 *
 *   {
 *     "crimeopus-default": {
 *       "display": "CrimeOpus 4.7",
 *       "providers": [
 *         { "provider": "together",  "model": "yourorg/CrimeOpus-4.7" },
 *         { "provider": "fireworks", "model": "accounts/yourorg/models/crimeopus-47" },
 *         { "provider": "ollama-dev","model": "crimeopus-default:latest" }
 *       ]
 *     }
 *   }
 *
 * Failover order: catalog order, skipping providers that are unhealthy
 * or out of slots.
 */
import { existsSync, readFileSync } from "node:fs"
import { emitWebhook } from "./webhooks.ts"

export type ProviderKind = "openai" | "ollama"

export interface Provider {
  id: string
  kind: ProviderKind
  url: string
  apiKey?: string
  weight: number
  maxInflight: number
  inflight: number
  healthy: boolean
  lastHealthCheck: number
  /** path to call for health check (default /v1/models for openai, /api/tags for ollama) */
  healthPath: string
}

export interface ProviderRoute {
  provider: string
  model: string
}

export interface CatalogEntry {
  display?: string
  description?: string
  hidden?: boolean
  systemPrefix?: string
  providers: ProviderRoute[]
}

const RAW_PROVIDERS = process.env.UPSTREAM_PROVIDERS ?? ""
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS ?? 30_000)
const QUEUE_MAX = Number(process.env.QUEUE_MAX ?? 50)
const PER_KEY_CONCURRENCY = Number(process.env.PER_KEY_CONCURRENCY ?? 2)

export const providers: Provider[] = (() => {
  if (!RAW_PROVIDERS) {
    // Backwards-compat: fall back to plain OLLAMA_URL if no providers JSON given
    const url = (process.env.OLLAMA_URL ?? "").replace(/\/+$/, "")
    if (!url) {
      console.warn(
        "ℹ no UPSTREAM_PROVIDERS configured — gateway will refuse every chat/embed request. " +
          "Set UPSTREAM_PROVIDERS env (see README) or fall back to OLLAMA_URL.",
      )
      return []
    }
    return [
      {
        id: "default-ollama",
        kind: "ollama",
        url,
        weight: 1,
        maxInflight: Number(process.env.MAX_CONCURRENCY ?? 2),
        inflight: 0,
        healthy: true,
        lastHealthCheck: 0,
        healthPath: "/api/tags",
      },
    ]
  }
  let parsed: Array<Partial<Provider>>
  try {
    parsed = JSON.parse(RAW_PROVIDERS)
  } catch (e) {
    console.error(`✗ UPSTREAM_PROVIDERS not valid JSON: ${(e as Error).message}`)
    return []
  }
  return parsed.map((p, i) => {
    const kind = (p.kind ?? "openai") as ProviderKind
    return {
      id: p.id ?? `provider-${i}`,
      kind,
      url: (p.url ?? "").replace(/\/+$/, ""),
      apiKey: p.apiKey,
      weight: p.weight ?? 1,
      maxInflight: p.maxInflight ?? Number(process.env.MAX_CONCURRENCY ?? 4),
      inflight: 0,
      healthy: true,
      lastHealthCheck: 0,
      healthPath: kind === "ollama" ? "/api/tags" : "/v1/models",
    }
  })
})()

const providerById = new Map(providers.map((p) => [p.id, p]))

// ─── Catalog ─────────────────────────────────────────────────────────

export const catalog: Map<string, CatalogEntry> = (() => {
  const m = new Map<string, CatalogEntry>()
  const path = process.env.CATALOG_PATH ?? "./catalog.json"
  if (!existsSync(path)) return m
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, CatalogEntry | unknown>
    for (const [id, e] of Object.entries(raw)) {
      if (id.startsWith("_")) continue
      const entry = e as CatalogEntry
      if (!Array.isArray(entry.providers)) {
        // Auto-migrate v0.2 catalog (single upstream string) → v0.3 (provider routes)
        const legacy = e as { upstream?: string }
        if (legacy.upstream && providers[0]) {
          entry.providers = [{ provider: providers[0].id, model: legacy.upstream }]
        }
      }
      if (entry.providers && entry.providers.length > 0) m.set(id, entry)
    }
  } catch (e) {
    console.error(`✗ failed to parse catalog: ${(e as Error).message}`)
  }
  return m
})()

// ─── Slot reservation across the provider pool ──────────────────────

interface Reservation {
  provider: Provider
  upstreamModel: string
  release: () => void
}

const perKeyInflight = new Map<string, number>()
const queue: Array<{
  resolve: (r: Reservation) => void
  reject: (e: Error) => void
  publicModel: string
  keyLabel: string
  enqueuedAt: number
  timeout: ReturnType<typeof setTimeout>
}> = []

export class UpstreamError extends Error {
  constructor(public code: string, public httpStatus: number) {
    super(code)
  }
}

/**
 * Reserve a slot for a public model. Walks the catalog's provider list
 * in order, picks the first healthy provider with a free slot. If
 * nothing is available, queues the caller (up to QUEUE_MAX with a
 * QUEUE_TIMEOUT_MS deadline).
 */
export async function acquireSlot(publicModel: string, keyLabel: string): Promise<Reservation> {
  const entry = catalog.get(publicModel)
  if (!entry) throw new UpstreamError(`unknown_model:${publicModel}`, 404)

  // Per-key concurrency cap
  const cur = perKeyInflight.get(keyLabel) ?? 0
  if (cur >= PER_KEY_CONCURRENCY) {
    throw new UpstreamError("per_key_concurrency_exceeded", 429)
  }

  // Try immediate match in catalog order
  for (const route of entry.providers) {
    const p = providerById.get(route.provider)
    if (!p || !p.healthy || p.inflight >= p.maxInflight) continue
    p.inflight++
    perKeyInflight.set(keyLabel, cur + 1)
    return makeReservation(p, route.model, keyLabel)
  }

  // No slot anywhere — queue
  if (queue.length >= QUEUE_MAX) {
    emitWebhook("upstream.error", { reason: "queue_full", queue_size: queue.length, key_label: keyLabel })
    throw new UpstreamError("queue_full", 503)
  }
  return new Promise<Reservation>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const i = queue.findIndex((w) => w.resolve === innerResolve)
      if (i >= 0) queue.splice(i, 1)
      reject(new UpstreamError("queue_timeout", 504))
    }, QUEUE_TIMEOUT_MS)
    const innerResolve = (r: Reservation) => {
      clearTimeout(timeout)
      resolve(r)
    }
    queue.push({
      resolve: innerResolve,
      reject: (e) => {
        clearTimeout(timeout)
        reject(e)
      },
      publicModel,
      keyLabel,
      enqueuedAt: Date.now(),
      timeout,
    })
  })
}

function makeReservation(p: Provider, upstreamModel: string, keyLabel: string): Reservation {
  let released = false
  return {
    provider: p,
    upstreamModel,
    release: () => {
      if (released) return
      released = true
      p.inflight = Math.max(0, p.inflight - 1)
      const left = (perKeyInflight.get(keyLabel) ?? 1) - 1
      if (left <= 0) perKeyInflight.delete(keyLabel)
      else perKeyInflight.set(keyLabel, left)
      // Wake one waiter
      while (queue.length > 0) {
        const next = queue[0]
        if (!next) break
        const entry = catalog.get(next.publicModel)
        if (!entry) {
          queue.shift()
          next.reject(new UpstreamError(`unknown_model:${next.publicModel}`, 404))
          continue
        }
        // Per-key cap on the waiter
        if ((perKeyInflight.get(next.keyLabel) ?? 0) >= PER_KEY_CONCURRENCY) break
        let assigned: Reservation | null = null
        for (const route of entry.providers) {
          const pp = providerById.get(route.provider)
          if (!pp || !pp.healthy || pp.inflight >= pp.maxInflight) continue
          pp.inflight++
          perKeyInflight.set(next.keyLabel, (perKeyInflight.get(next.keyLabel) ?? 0) + 1)
          assigned = makeReservation(pp, route.model, next.keyLabel)
          break
        }
        if (!assigned) break
        queue.shift()
        next.resolve(assigned)
      }
    },
  }
}

// ─── HTTP forwarder ─────────────────────────────────────────────────

/**
 * Build a fetch request to the chosen provider, handling provider-kind
 * differences. The body is always passed through transparently; only
 * the URL and headers are customised.
 */
export function buildUpstreamFetch(
  provider: Provider,
  endpoint: "/v1/chat/completions" | "/v1/embeddings" | "/v1/audio/transcriptions" | "/v1/audio/translations",
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`

  if (provider.kind === "ollama") {
    // Ollama exposes /v1/* directly on its main port — same path
    return { url: `${provider.url}${endpoint}`, headers }
  }
  // OpenAI-compatible providers all expose /v1 under their base URL.
  // The base URL we got already includes /v1 (e.g. api.together.xyz/v1)
  // so we strip our /v1 prefix to avoid /v1/v1.
  const stripped = endpoint.replace(/^\/v1/, "")
  return { url: `${provider.url}${stripped}`, headers }
}

// ─── Health checks ──────────────────────────────────────────────────

let healthInterval: ReturnType<typeof setInterval> | null = null

export function startHealthChecks(): void {
  if (healthInterval) return
  const tick = async () => {
    for (const p of providers) {
      try {
        const req: RequestInit = { signal: AbortSignal.timeout(3000) }
        if (p.apiKey) req.headers = { Authorization: `Bearer ${p.apiKey}` }
        const r = await fetch(`${p.url}${p.healthPath}`, req)
        const wasHealthy = p.healthy
        p.healthy = r.ok || r.status === 401 // 401 still means alive — wrong key
        p.lastHealthCheck = Date.now()
        if (!wasHealthy && p.healthy) console.log(`✓ ${p.id} recovered`)
        if (wasHealthy && !p.healthy) {
          console.warn(`✗ ${p.id} down`)
          emitWebhook("upstream.error", { provider: p.id, reason: "health_check_failed" })
        }
      } catch (e) {
        if (p.healthy) {
          console.warn(`✗ ${p.id} unreachable: ${(e as Error).message}`)
          emitWebhook("upstream.error", { provider: p.id, error: (e as Error).message })
        }
        p.healthy = false
        p.lastHealthCheck = Date.now()
      }
    }
  }
  void tick()
  healthInterval = setInterval(() => void tick(), 30_000)
}

// ─── Stats for /admin ───────────────────────────────────────────────

export function getProviderStats() {
  return {
    providers: providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      url: p.url.replace(/(:\/\/[^@]*@)/, "://***@"),
      hasApiKey: !!p.apiKey,
      inflight: p.inflight,
      maxInflight: p.maxInflight,
      utilization: p.maxInflight ? p.inflight / p.maxInflight : 0,
      healthy: p.healthy,
      weight: p.weight,
      lastHealthCheckAgo: p.lastHealthCheck ? Date.now() - p.lastHealthCheck : null,
    })),
    queue: {
      length: queue.length,
      max: QUEUE_MAX,
      oldestAgeMs: queue[0] ? Date.now() - queue[0].enqueuedAt : 0,
    },
    perKeyInflight: Object.fromEntries(perKeyInflight),
    catalog: catalog.size,
  }
}

export function listPublicModels(): Array<{ id: string; display: string; description?: string; hidden?: boolean }> {
  return [...catalog.entries()]
    .filter(([, e]) => !e.hidden)
    .map(([id, e]) => ({ id, display: e.display ?? id, description: e.description }))
}

export function getCatalogEntry(publicModel: string): CatalogEntry | null {
  return catalog.get(publicModel) ?? null
}
