import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    // AuthGate stores Telegram JWT sessions as { username: "bearer", password: <jwt> }.
    // Emit a Bearer token in that case, otherwise stick with Basic for legacy
    // self-hosted servers.
    if (server.username === "bearer") {
      return { Authorization: `Bearer ${server.password}` }
    }
        // Use proper base64 encoding
        const credentials = `${server.username ?? "opencode"}:${server.password}`
        let encoded: string
        if (typeof btoa === "function") {
          encoded = btoa(credentials)
        } else {
          encoded = Buffer.from(credentials).toString("base64")
        }
        return {
          Authorization: `Basic ${encoded}`,
        }
  })()

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth, "ngrok-skip-browser-warning": "1" },
    baseUrl: server.url,
  })
}
