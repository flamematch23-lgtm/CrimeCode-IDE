import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./http_client.txt"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

export const HttpClientTool = Tool.define("http_client", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().describe("Full URL including query string if needed"),
      method: z.enum(METHODS).optional().default("GET").describe("HTTP method (default: GET)"),
      headers: z.record(z.string(), z.string()).optional().describe("Request headers as key-value pairs"),
      body: z.string().optional().describe("Request body (JSON string or plain text)"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default: 15000)"),
      follow_redirects: z.boolean().optional().default(true).describe("Follow redirects (default: true)"),
    }),
    async execute(params, _ctx) {
      const timeout = params.timeout ?? 15000
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)

      let status = 0
      let resUrl = params.url
      let contentType = ""
      let error = ""
      let output = ""

      try {
        const res = await fetch(params.url, {
          method: params.method ?? "GET",
          headers: params.headers as HeadersInit | undefined,
          body: params.body ?? undefined,
          redirect: params.follow_redirects === false ? "manual" : "follow",
          signal: ctrl.signal,
        })

        status = res.status
        resUrl = res.url
        const resHeaders: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          resHeaders[k] = v
        })
        contentType = resHeaders["content-type"] ?? ""

        const raw = await res.text()
        let body = raw
        if (contentType.includes("application/json")) {
          try {
            body = JSON.stringify(JSON.parse(raw), null, 2)
          } catch {}
        }

        output = [
          `Status: ${res.status} ${res.statusText}`,
          `URL: ${res.url}`,
          `Headers:\n${Object.entries(resHeaders)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n")}`,
          `Body:\n${body.slice(0, 8000)}${body.length > 8000 ? "\n... [truncated]" : ""}`,
        ].join("\n\n")
      } catch (err: any) {
        error = err.name === "AbortError" ? `Request timed out after ${timeout}ms` : err.message
        output = `Error: ${error}`
      } finally {
        clearTimeout(timer)
      }

      return {
        title: `HTTP ${params.method ?? "GET"} ${params.url}`,
        output,
        metadata: { status, url: resUrl, contentType, error },
      }
    },
  }
})
