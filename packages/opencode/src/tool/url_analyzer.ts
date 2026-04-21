import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Analyze URLs for security issues and extract detailed information"

const PARAMETERS = z.object({
  url: z.string().describe("URL to analyze"),
  checkSafety: z.boolean().optional().describe("Check if URL is safe (default: true)"),
})

export const URLAnalyzerTool = Tool.define("url_analyzer", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().describe("URL to analyze"),
      checkSafety: z.boolean().optional().describe("Check if URL is safe (default: true)"),
    }),
    async execute(params) {
      let parsedUrl: URL
      try {
        parsedUrl = new URL(params.url)
      } catch {
        return {
          title: "URL Analyzer",
          output: `Invalid URL: ${params.url}`,
          metadata: { action: "url_analyzer", result: "error" },
        }
      }

      const issues: string[] = []
      const warnings: string[] = []
      const info: string[] = []

      info.push(`**Protocol**: ${parsedUrl.protocol.replace(":", "")}`)
      info.push(`**Hostname**: ${parsedUrl.hostname}`)
      if (parsedUrl.port) info.push(`**Port**: ${parsedUrl.port}`)
      info.push(`**Path**: ${parsedUrl.pathname || "/"}`)
      if (parsedUrl.search) info.push(`**Query Parameters**: ${parsedUrl.searchParams.toString()}`)

      if (parsedUrl.protocol === "http:") {
        warnings.push("Uses unencrypted HTTP instead of HTTPS")
      }

      if (!parsedUrl.protocol.startsWith("http")) {
        issues.push(`Dangerous protocol: ${parsedUrl.protocol}`)
      }

      const dangerousProtocols = ["javascript:", "data:", "vbscript:"]
      if (dangerousProtocols.some((p) => parsedUrl.protocol === p)) {
        issues.push(`Potentially dangerous protocol: ${parsedUrl.protocol}`)
      }

      if (parsedUrl.hostname.includes("@")) {
        warnings.push("Contains @ symbol - possible credential hiding")
      }

      const suspiciousPatterns = [
        { pattern: /\.\./gi, desc: "Path traversal (../)" },
        { pattern: /%2e%2e/gi, desc: "Encoded path traversal" },
        { pattern: /<[^>]*>/gi, desc: "Possible XSS attempt (<>)" },
        { pattern: /javascript:/gi, desc: "JavaScript URI scheme" },
        { pattern: /on\w+\s*=/gi, desc: "Possible event handler injection" },
      ]

      const urlString = params.url.toLowerCase()
      for (const { pattern, desc } of suspiciousPatterns) {
        if (pattern.test(urlString)) {
          warnings.push(`Suspicious pattern detected: ${desc}`)
        }
      }

      if (parsedUrl.password) {
        warnings.push("Contains password in URL (credentials exposed)")
      }

      if (parsedUrl.username === "anonymous" || parsedUrl.username === "admin") {
        info.push(`Username hint: ${parsedUrl.username}`)
      }

      const tlds = [".tk", ".ml", ".ga", ".cf", ".gq"]
      const isFreeTLD = tlds.some((tld) => parsedUrl.hostname.endsWith(tld))
      if (isFreeTLD) {
        warnings.push("Uses free TLD often used in phishing")
      }

      const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/
      if (ipPattern.test(parsedUrl.hostname)) {
        warnings.push("Uses IP address instead of domain name")
      }

      const suspiciousTLDs = [".xyz", ".top", ".work", ".click", ".link"]
      const isSuspiciousTLD = suspiciousTLDs.some((tld) => parsedUrl.hostname.endsWith(tld))
      if (isSuspiciousTLD) {
        warnings.push("Uses TLD commonly associated with suspicious sites")
      }

      let output = `## URL Analyzer\n\n**URL**: ${params.url}\n\n`

      if (issues.length > 0) {
        output += `### Issues (${issues.length})\n\n`
        for (const issue of issues) {
          output += `- **${issue}**\n`
        }
        output += "\n"
      }

      if (warnings.length > 0) {
        output += `### Warnings (${warnings.length})\n\n`
        for (const warning of warnings) {
          output += `- ${warning}\n`
        }
        output += "\n"
      }

      if (info.length > 0) {
        output += `### Information\n\n`
        for (const i of info) {
          output += `- ${i}\n`
        }
        output += "\n"
      }

      if (issues.length === 0 && warnings.length === 0) {
        output += "### Assessment\n\nNo obvious security issues detected.\n\n"
      } else if (issues.length === 0) {
        output += "### Assessment\n\nNo critical issues, but review warnings.\n\n"
      } else {
        output += "### Assessment\n\n**WARNING**: This URL has security concerns. Be cautious.\n\n"
      }

      return {
        title: "URL Analyzer",
        output,
        metadata: {
          action: "url_analyzer",
          result: issues.length > 0 ? "issues_found" : warnings.length > 0 ? "warnings" : "ok",
        },
      }
    },
  }
})
