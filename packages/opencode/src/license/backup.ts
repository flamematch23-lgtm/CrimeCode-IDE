import { createHash, createHmac } from "node:crypto"
import { gzipSync } from "node:zlib"
import { readFileSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Log } from "../util/log"
import { captureException } from "./sentry"
import { getDb } from "./db"

const log = Log.create({ service: "license-backup" })

const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000 // 12 hours

let stopped = false
let timer: ReturnType<typeof setTimeout> | null = null

function s3Config(): {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
} | null {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.BACKUP_S3_ENDPOINT
  const bucket = process.env.BUCKET_NAME ?? process.env.BACKUP_S3_BUCKET
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.BACKUP_S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.BACKUP_S3_SECRET_ACCESS_KEY
  const region = process.env.AWS_REGION ?? process.env.BACKUP_S3_REGION ?? "auto"
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return { endpoint, bucket, region, accessKeyId, secretAccessKey }
}

/**
 * Sign and PUT an object using AWS Signature V4. Works with any S3-compatible
 * service (Tigris, R2, MinIO, AWS S3 itself).
 */
async function putObject(key: string, body: Uint8Array, contentType = "application/gzip"): Promise<void> {
  const cfg = s3Config()
  if (!cfg) throw new Error("backup: S3 env vars not configured")

  const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${key}`)
  const host = url.host
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = createHash("sha256").update(body).digest("hex")

  const canonicalUri = encodeURI(url.pathname).replace(/%2F/g, "/")
  const canonicalQuery = ""
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const algorithm = "AWS4-HMAC-SHA256"
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")

  const kDate = createHmac("sha256", `AWS4${cfg.secretAccessKey}`).update(dateStamp).digest()
  const kRegion = createHmac("sha256", kDate).update(cfg.region).digest()
  const kService = createHmac("sha256", kRegion).update("s3").digest()
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest()
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")

  const authorization =
    `${algorithm} Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Host: host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
    },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`s3 put ${res.status}: ${text.slice(0, 400)}`)
  }
}

function objectKey(): string {
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(now.getUTCDate()).padStart(2, "0")
  const hhmmss = now.toISOString().slice(11, 19).replaceAll(":", "")
  return `licenses/${yyyy}/${mm}/${dd}/licenses-${yyyy}${mm}${dd}T${hhmmss}Z.db.gz`
}

export async function backupOnce(): Promise<{ ok: true; key: string; size: number } | { ok: false; error: string }> {
  const cfg = s3Config()
  if (!cfg) {
    return { ok: false, error: "S3 env vars not configured" }
  }
  // Atomic snapshot via VACUUM INTO — produces a clean .db file we can ship.
  const tmpPath = join(tmpdir(), `licenses-snapshot-${Date.now()}.db`)
  try {
    const db = getDb()
    db.exec("VACUUM INTO '" + tmpPath.replaceAll("'", "''") + "'")
    const raw = readFileSync(tmpPath)
    const gz = gzipSync(raw, { level: 9 })
    const key = objectKey()
    await putObject(key, gz, "application/gzip")
    const stats = statSync(tmpPath)
    log.info("backup uploaded", { key, raw: stats.size, gz: gz.byteLength })
    return { ok: true, key, size: gz.byteLength }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn("backup failed", { error: msg })
    captureException(err, { tags: { surface: "license-backup" } })
    return { ok: false, error: msg }
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // already gone
    }
  }
}

export function startBackupScheduler(): void {
  if (timer) return
  if (!s3Config()) {
    log.info("backup S3 env vars not set — scheduler disabled")
    return
  }
  log.info("starting backup scheduler", { interval_hours: BACKUP_INTERVAL_MS / 3_600_000 })
  // First backup ~30s after startup so the DB is warm; then every 12h.
  const tick = async () => {
    if (stopped) return
    try {
      await backupOnce()
    } catch (err) {
      log.warn("backup tick error", { error: err instanceof Error ? err.message : String(err) })
    }
    timer = setTimeout(tick, BACKUP_INTERVAL_MS)
  }
  timer = setTimeout(tick, 30_000)
}

export function stopBackupScheduler(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
