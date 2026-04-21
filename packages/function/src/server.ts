import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { BlobServiceClient } from "@azure/storage-blob"

const blobClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING || "",
)
const container = blobClient.getContainerClient("share")

// In-memory state replacing DurableObjects
const sessions = new Map<string, { secret: string; sessionID: string; subs: Set<WebSocket> }>()

function shortName(id: string) {
  return id.substring(id.length - 8)
}

async function publish(short: string, key: string, content: unknown) {
  const blob = container.getBlockBlobClient(`${key}.json`)
  await blob.uploadData(Buffer.from(JSON.stringify(content)), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  })
  const state = sessions.get(short)
  if (!state) return
  const msg = JSON.stringify({ key, content })
  for (const ws of state.subs) ws.send(msg)
}

const app = new Hono()
  .get("/", (c) => c.text("CrimeCode API"))
  .post("/share_create", async (c) => {
    const { sessionID } = await c.req.json<{ sessionID: string }>()
    const short = shortName(sessionID)
    const secret = randomUUID()
    sessions.set(short, { secret, sessionID, subs: new Set() })
    return c.json({ secret, url: `https://${process.env.WEB_DOMAIN}/s/${short}` })
  })
  .post("/share_delete", async (c) => {
    const { sessionID, secret } = await c.req.json<{ sessionID: string; secret: string }>()
    const short = shortName(sessionID)
    const state = sessions.get(short)
    if (!state || state.secret !== secret) return c.json({ error: "Invalid secret" }, 403)
    sessions.delete(short)
    return c.json({})
  })
  .post("/share_delete_admin", async (c) => {
    const { sessionShortName, adminSecret } = await c.req.json<{
      sessionShortName: string
      adminSecret: string
    }>()
    if (adminSecret !== process.env.ADMIN_SECRET) return c.json({ error: "Invalid admin secret" }, 403)
    sessions.delete(sessionShortName)
    return c.json({})
  })
  .post("/share_sync", async (c) => {
    const body = await c.req.json<{ sessionID: string; secret: string; key: string; content: unknown }>()
    const short = shortName(body.sessionID)
    const state = sessions.get(short)
    if (!state || state.secret !== body.secret) return c.json({ error: "Invalid secret" }, 403)
    await publish(short, body.key, body.content)
    return c.json({})
  })
  .get("/share_data", async (c) => {
    const id = c.req.query("id")
    if (!id) return c.text("Share ID required", 400)
    const blobs = container.listBlobsFlat({ prefix: `session/` })
    let info: unknown
    const messages: Record<string, unknown> = {}
    for await (const blob of blobs) {
      const bc = container.getBlockBlobClient(blob.name)
      const dl = await bc.downloadToBuffer()
      const content = JSON.parse(dl.toString())
      const key = blob.name.replace(/\.json$/, "")
      const [root, type, ...rest] = key.split("/")
      if (root !== "session") continue
      if (type === "info") { info = content; continue }
      if (type === "message") messages[content.id] = { parts: [], ...content }
      if (type === "part" && messages[content.messageID]) {
        ;(messages[content.messageID] as { parts: unknown[] }).parts.push(content)
      }
    }
    return c.json({ info, messages })
  })
  .get("/share_poll", (c) => {
    const id = c.req.query("id")
    if (!id) return c.text("Share ID required", 400)
    const upgrade = c.req.header("Upgrade")
    if (upgrade !== "websocket") return c.text("Upgrade header required", 426)

    const server = Bun.upgradeWebSocket
      ? c.req.raw
      : null
    if (!server) return c.text("WebSocket upgrade failed", 500)

    // Bun handles WS upgrade; return placeholder (Bun intercepts)
    return new Response(null, { status: 101 })
  })
  .post("/exchange_github_app_token", async (c) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "")
    if (!token) return c.json({ error: "Authorization required" }, 401)
    const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"))
    let owner: string, repo: string
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: "https://token.actions.githubusercontent.com",
        audience: "opencode-github-action",
      })
      const parts = (payload.sub as string).split(":")[1].split("/")
      owner = parts[0]
      repo = parts[1]
    } catch {
      return c.json({ error: "Invalid token" }, 403)
    }
    const auth = createAppAuth({ appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_APP_PRIVATE_KEY! })
    const appAuth = await auth({ type: "app" })
    const octokit = new Octokit({ auth: appAuth.token })
    const { data: installation } = await octokit.apps.getRepoInstallation({ owner, repo })
    const installAuth = await auth({ type: "installation", installationId: installation.id })
    return c.json({ token: installAuth.token })
  })
  .post("/feishu", async (c) => {
    const body = await c.req.json<{ challenge?: string; event?: { message?: { content?: string; root_id?: string; message_id?: string } } }>()
    if (body.challenge) return c.json({ challenge: body.challenge })
    const content = body.event?.message?.content
    const parsed = typeof content === "string" && content.trim().startsWith("{")
      ? (JSON.parse(content) as { text?: string }) : undefined
    let message = (parsed?.text ?? content ?? "").trim().replace(/^@_user_\d+\s*/, "").replace(/^aiden,?\s*/i, `<@759257817772851260> `)
    if (!message) return c.json({ ok: true })
    const threadId = body.event?.message?.root_id || body.event?.message?.message_id
    if (threadId) message = `${message} [${threadId}]`
    const res = await fetch(`https://discord.com/api/v10/channels/${process.env.DISCORD_SUPPORT_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${process.env.DISCORD_SUPPORT_BOT_TOKEN}` },
      body: JSON.stringify({ content: message }),
    })
    if (!res.ok) return c.json({ error: "Discord error" }, 502)
    return c.json({ ok: true })
  })

const port = parseInt(process.env.PORT || "3000", 10)
export default {
  port,
  fetch: app.fetch,
  websocket: {
    open(ws: { data: { id: string } }) {
      const state = sessions.get(ws.data.id)
      if (state) state.subs.add(ws as unknown as WebSocket)
    },
    close(ws: { data: { id: string } }) {
      const state = sessions.get(ws.data.id)
      if (state) state.subs.delete(ws as unknown as WebSocket)
    },
    message() {},
  },
}
