/**
 * License auth routes — PIN-based Telegram magic-link flow.
 * Mounted at /license on the main CrimeOpus API.
 */
import { Hono } from "hono"
import { startAuth, pollAuth, checkRateLimit } from "./license-auth.ts"

export function licenseRouter() {
  const app = new Hono()

  app.post("/auth/start", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown"
    const rl = checkRateLimit("auth-start:" + ip)
    if (!rl.ok) {
      return c.json({ error: "rate_limited", retry_after: rl.retryAfterSeconds }, 429)
    }
    let body: { device_label?: string } = {}
    try {
      body = (await c.req.json()) ?? {}
    } catch {
      // body optional
    }
    const started = startAuth({ device_label: body.device_label?.slice(0, 80) ?? null })
    return c.json(started)
  })

  app.get("/auth/poll/:pin", (c) => {
    const pin = c.req.param("pin").toUpperCase()
    if (!/^[A-Z0-9]{4,32}$/.test(pin)) return c.json({ status: "unknown" }, 400)
    return c.json(pollAuth(pin))
  })

  return app
}
