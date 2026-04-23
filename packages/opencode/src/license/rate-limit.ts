const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX = 10
const MAX_BUCKET_KEYS = 50_000 // hard cap on memory growth

const buckets = new Map<string, number[]>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - DEFAULT_WINDOW_MS
    for (const [key, arr] of buckets) {
      const filtered = arr.filter((t) => t > cutoff)
      if (filtered.length === 0) buckets.delete(key)
      else buckets.set(key, filtered)
    }
    if (buckets.size > MAX_BUCKET_KEYS) {
      // memory safety net — drop the oldest keys if abuse explodes the map
      const overflow = buckets.size - MAX_BUCKET_KEYS
      const it = buckets.keys()
      for (let i = 0; i < overflow; i++) {
        const k = it.next().value
        if (k) buckets.delete(k)
      }
    }
  }, 60_000)
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds?: number
}

export interface RateLimitOpts {
  /** Max requests allowed per window. Defaults to 10. */
  max?: number
  /** Window length in ms. Defaults to 60_000. */
  windowMs?: number
}

/**
 * Sliding-window rate limiter. `key` is the bucket identity (IP, license
 * signature, customer id, ... whatever makes sense for the caller). Callers
 * that want tier-based quotas should namespace the key — e.g. "pro:<sig>"
 * vs "free:<ip>" — so the buckets don't collide.
 */
export function checkRateLimit(key: string, opts: RateLimitOpts = {}): RateLimitResult {
  startCleanup()
  const max = opts.max ?? DEFAULT_MAX
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const now = Date.now()
  const cutoff = now - windowMs
  const arr = (buckets.get(key) ?? []).filter((t) => t > cutoff)
  if (arr.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000))
    buckets.set(key, arr)
    return { ok: false, remaining: 0, retryAfterSeconds: retryAfter }
  }
  arr.push(now)
  buckets.set(key, arr)
  return { ok: true, remaining: max - arr.length }
}

/** Testing helper: wipe all buckets between specs. */
export function __resetRateLimitBuckets(): void {
  buckets.clear()
}
