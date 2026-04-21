import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Analyze HTTP security headers and provide security recommendations"

const PARAMETERS = z.object({
  url: z.string().describe("URL to analyze security headers"),
})

export const SecurityHeadersTool = Tool.define("security_headers", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().describe("URL to analyze security headers"),
    }),
    async execute(params) {
      let status = 0
      let headers: Record<string, string> = {}
      let error = ""

      try {
        const res = await fetch(params.url, {
          method: "HEAD",
          redirect: "follow",
        })
        status = res.status
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } catch (err: any) {
        error = err.message
      }

      if (error) {
        return {
          title: "Security Headers Analysis",
          output: `Error: ${error}`,
          metadata: { action: "security_headers", result: "error", present: 0, missing: 0 },
        }
      }

      const securityHeaders: Record<
        string,
        { present: boolean; value: string; importance: string; description: string }
      > = {
        "strict-transport-security": {
          present: false,
          value: "",
          importance: "High",
          description: "Enforces HTTPS connections (HSTS)",
        },
        "content-security-policy": {
          present: false,
          value: "",
          importance: "High",
          description: "Prevents XSS and data injection attacks",
        },
        "x-content-type-options": {
          present: false,
          value: "",
          importance: "Medium",
          description: "Prevents MIME type sniffing",
        },
        "x-frame-options": {
          present: false,
          value: "",
          importance: "Medium",
          description: "Prevents clickjacking attacks",
        },
        "x-xss-protection": {
          present: false,
          value: "",
          importance: "Low",
          description: "Legacy XSS protection (deprecated)",
        },
        "referrer-policy": {
          present: false,
          value: "",
          importance: "Medium",
          description: "Controls referrer information",
        },
        "permissions-policy": {
          present: false,
          value: "",
          importance: "Medium",
          description: "Controls browser features and APIs",
        },
        "cache-control": {
          present: false,
          value: "",
          importance: "Medium",
          description: "Controls caching behavior (sensitive data)",
        },
        "set-cookie": {
          present: false,
          value: "",
          importance: "High",
          description: "Cookie security flags (HttpOnly, Secure, SameSite)",
        },
      }

      for (const [header, config] of Object.entries(securityHeaders)) {
        if (headers[header]) {
          config.present = true
          config.value = headers[header]
        }
      }

      const presentHeaders = Object.entries(securityHeaders).filter(([, v]) => v.present)
      const missingHeaders = Object.entries(securityHeaders).filter(([, v]) => !v.present)

      let output = `## Security Headers Analysis\n\n**URL**: ${params.url}\n**Status**: ${status}\n\n`

      if (presentHeaders.length > 0) {
        output += `### Present Headers (${presentHeaders.length})\n\n`
        output += `| Header | Value | Importance |\n|------|-------|------------|\n`
        for (const [name, config] of presentHeaders) {
          const displayValue = config.value.length > 50 ? config.value.slice(0, 50) + "..." : config.value
          output += `| ${name} | \`${displayValue}\` | ${config.importance} |\n`
        }
        output += "\n"
      }

      if (missingHeaders.length > 0) {
        output += `### Missing Headers (${missingHeaders.length})\n\n`
        output += `| Header | Importance | Description |\n|------|------------|-------------|\n`
        for (const [name, config] of missingHeaders) {
          output += `| ${name} | ${config.importance} | ${config.description} |\n`
        }
        output += "\n"
      }

      const highImportanceMissing = missingHeaders.filter(([, v]) => v.importance === "High")
      if (highImportanceMissing.length > 0) {
        output += `### Recommendations\n\n`
        for (const [name, config] of highImportanceMissing) {
          output += `- **${name}**: Consider adding this header for better security\n`
        }
      }

      return {
        title: "Security Headers Analysis",
        output,
        metadata: {
          action: "security_headers",
          present: presentHeaders.length,
          missing: missingHeaders.length,
          result: "success",
        },
      }
    },
  }
})
