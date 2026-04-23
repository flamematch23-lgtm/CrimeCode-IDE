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
    return {
      Authorization: `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth, "ngrok-skip-browser-warning": "1" },
    baseUrl: server.url,
  })
}
