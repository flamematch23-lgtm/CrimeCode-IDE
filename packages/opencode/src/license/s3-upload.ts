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
