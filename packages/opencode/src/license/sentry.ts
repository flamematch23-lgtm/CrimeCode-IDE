import { Log } from "../util/log"

const log = Log.create({ service: "sentry" })

let initialized = false
let sentryMod: typeof import("@sentry/node") | null = null

export async function initSentry(): Promise<void> {
  if (initialized) return
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    log.info("SENTRY_DSN not set — Sentry disabled")
    return
  }
  try {
    sentryMod = await import("@sentry/node")
    sentryMod.init({
      dsn,
      environment: process.env.OPENCODE_CHANNEL ?? "dev",
      release: process.env.OPENCODE_VERSION ?? "1.0.0",
      tracesSampleRate: 0.05,
      // Capture unhandled rejections + uncaught exceptions in addition to
      // the explicit captureException calls below.
      integrations: (defaults) => defaults,
      // Don't send PII (we already avoid storing it, but belt-and-braces).
      sendDefaultPii: false,
    })
    initialized = true
    log.info("sentry initialized", { env: process.env.OPENCODE_CHANNEL ?? "dev" })
  } catch (err) {
    log.warn("failed to init sentry", { error: err instanceof Error ? err.message : String(err) })
  }
}

export function captureException(err: unknown, ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> }): void {
  if (!initialized || !sentryMod) return
  try {
    sentryMod.captureException(err, ctx)
  } catch {
    // never let Sentry crash the caller
  }
}

export function captureMessage(message: string, level: "info" | "warning" | "error" = "info"): void {
  if (!initialized || !sentryMod) return
  try {
    sentryMod.captureMessage(message, level)
  } catch {
    // ignore
  }
}
