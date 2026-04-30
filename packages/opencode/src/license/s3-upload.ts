import { createHash, createHmac } from "node:crypto"

/**
 * Minimal S3-compatible PUT helper using AWS Signature V4. Works against
 * Cloudflare R2, Tigris, MinIO and AWS S3 — anything that speaks the
 * sigv4 PUT-object API. Extracted from `backup.ts` so the same primitive
 * can serve other features (chat attachments, future asset uploads).
 *
 * Reuses the BUCKET_NAME / AWS_ENDPOINT_URL_S3 / AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY env vars already wired in production.
 */

export interface S3Config {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Public base URL where uploaded objects are served from (CDN). */
  publicBaseUrl?: string
}

export function s3Config(): S3Config | null {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.BACKUP_S3_ENDPOINT
  const bucket = process.env.BUCKET_NAME ?? process.env.BACKUP_S3_BUCKET
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.BACKUP_S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.BACKUP_S3_SECRET_ACCESS_KEY
  const region = process.env.AWS_REGION ?? process.env.BACKUP_S3_REGION ?? "auto"
  // CRIMECODE_R2_PUBLIC_URL is the production CDN front for the bucket
  // (e.g. https://cdn.crimecode.cc). Falls back to the endpoint+bucket so
  // self-hosted setups still get a usable URL even without a CDN.
  const publicBaseUrl = process.env.CRIMECODE_R2_PUBLIC_URL
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, publicBaseUrl }
}

export async function s3Put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }> {
  const cfg = s3Config()
  if (!cfg) throw new Error("s3: env vars not configured")

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
    body: body as BodyInit,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`s3 put ${res.status}: ${text.slice(0, 400)}`)
  }

  const publicUrl = cfg.publicBaseUrl
    ? `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key}`
    : `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${key}`
  return { url: publicUrl }
}

/**
 * Generate a presigned GET URL for a private object. The URL is valid for
 * `ttlSec` seconds and lets the bearer download the bytes without any
 * additional auth — so we generate them on demand from the team-scoped
 * proxy route, never store them.
 *
 * Implements AWS Signature V4 query-string variant (X-Amz-* params).
 */
export function s3GetSigned(key: string, ttlSec = 300): string {
  const cfg = s3Config()
  if (!cfg) throw new Error("s3: env vars not configured")
  const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${key}`)
  const host = url.host
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const algorithm = "AWS4-HMAC-SHA256"
  // The query string MUST be sorted by key for the canonical form.
  const params = new URLSearchParams()
  params.set("X-Amz-Algorithm", algorithm)
  params.set("X-Amz-Credential", `${cfg.accessKeyId}/${credentialScope}`)
  params.set("X-Amz-Date", amzDate)
  params.set("X-Amz-Expires", String(Math.max(60, Math.min(7 * 24 * 3600, ttlSec))))
  params.set("X-Amz-SignedHeaders", "host")
  // Sort: URLSearchParams keeps insertion order; we rebuild sorted manually.
  const sorted = Array.from(params.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, "%20")}`)
    .join("&")
  const canonicalUri = encodeURI(url.pathname).replace(/%2F/g, "/")
  const canonicalHeaders = `host:${host}\n`
  const signedHeaders = "host"
  const payloadHash = "UNSIGNED-PAYLOAD"
  const canonicalRequest = ["GET", canonicalUri, sorted, canonicalHeaders, signedHeaders, payloadHash].join("\n")
  const stringToSign = [algorithm, amzDate, credentialScope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n")
  const kDate = createHmac("sha256", `AWS4${cfg.secretAccessKey}`).update(dateStamp).digest()
  const kRegion = createHmac("sha256", kDate).update(cfg.region).digest()
  const kService = createHmac("sha256", kRegion).update("s3").digest()
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest()
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")
  return `${url.origin}${canonicalUri}?${sorted}&X-Amz-Signature=${signature}`
}

/**
 * Given a stored attachment URL (which historically may be either the
 * proxy form `/license/teams/<id>/chat/attachments?key=...` or the raw
 * R2 URL), extract the object key (`chat/<teamId>/<file>`). Returns
 * null if the URL doesn't look like a chat attachment.
 */
export function extractChatAttachmentKey(url: string): string | null {
  if (!url) return null
  // Match anything with `/chat/<teamId>/<filename>` in the path. This
  // covers both old direct-R2 URLs and new proxy URLs that include
  // `?key=chat/...`.
  const m = url.match(/chat\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._\-]+)/)
  if (!m) return null
  return `chat/${m[1]}/${m[2]}`
}

/**
 * Sign a proxy URL with HMAC + TTL so plain HTML elements (`<img src>`,
 * `<a href>`) can dereference it without an Authorization header. The
 * signature binds the URL to a specific `team_id + key + expiry`.
 *
 * Defends against:
 *   - Cross-team key spoofing (team_id is part of the signed payload)
 *   - URL tampering after expiry (timestamp is part of the signed payload)
 *   - Replay after the TTL window (verifyAttachmentSignature rejects
 *     expired stamps)
 *
 * The HMAC secret is `LICENSE_HMAC_SECRET` — same secret used elsewhere
 * for session tokens. Rotating it invalidates all existing signed URLs,
 * forcing a refresh on next chat-history GET (which is the desired
 * security property).
 */
const ATTACHMENT_TTL_SEC = Number(process.env.CHAT_ATTACHMENT_TTL_SEC ?? 24 * 3600)

export function signAttachmentUrl(args: {
  apiBase: string
  team_id: string
  key: string
  ttlSec?: number
}): string {
  const secret = process.env.LICENSE_HMAC_SECRET ?? ""
  if (!secret) throw new Error("LICENSE_HMAC_SECRET not configured")
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSec ?? ATTACHMENT_TTL_SEC)
  const payload = `${args.team_id}\n${args.key}\n${exp}`
  const sig = createHmac("sha256", secret).update(payload).digest("hex")
  const qs = new URLSearchParams()
  qs.set("key", args.key)
  qs.set("exp", String(exp))
  qs.set("sig", sig)
  return `${args.apiBase.replace(/\/+$/, "")}/license/teams/${encodeURIComponent(args.team_id)}/chat/attachments?${qs.toString()}`
}

export function verifyAttachmentSignature(args: {
  team_id: string
  key: string
  exp: number
  sig: string
}): boolean {
  const secret = process.env.LICENSE_HMAC_SECRET ?? ""
  if (!secret) return false
  if (!Number.isFinite(args.exp)) return false
  if (args.exp < Math.floor(Date.now() / 1000)) return false
  const payload = `${args.team_id}\n${args.key}\n${args.exp}`
  const expected = createHmac("sha256", secret).update(payload).digest("hex")
  // Constant-time compare via length+xor to avoid timing leaks.
  if (expected.length !== args.sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ args.sig.charCodeAt(i)
  return diff === 0
}
