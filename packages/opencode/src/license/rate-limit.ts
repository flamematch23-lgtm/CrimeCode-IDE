const WINDOW_MS = 60_000
const MAX_REQUESTS = 10
const MAX_BUCKET_KEYS = 50_000 // hard cap on memory growth

const buckets = new Map<string, number[]>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS
    for (const [ip, arr] of buckets) {
      const filtered = arr.filter((t) => t > cutoff)
      if (filtered.length === 0) buckets.delete(ip)
      else buckets.set(ip, filtered)
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

export function checkRateLimit(ip: string): RateLimitResult {
  startCleanup()
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const arr = (buckets.get(ip) ?? []).filter((t) => t > cutoff)
  if (arr.length >= MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((arr[0] + WINDOW_MS - now) / 1000))
    buckets.set(ip, arr)
    return { ok: false, remaining: 0, retryAfterSeconds: retryAfter }
  }
  arr.push(now)
  buckets.set(ip, arr)
  return { ok: true, remaining: MAX_REQUESTS - arr.length }
}
