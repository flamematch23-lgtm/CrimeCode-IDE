import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Perform DNS reconnaissance: lookup records, find subdomains, and trace DNS propagation"

const PARAMETERS = z.object({
  action: z.enum(["lookup", "reverse", "subdomains", "propagation"]).describe("DNS action to perform"),
  domain: z.string().describe("Domain to query"),
  recordType: z
    .enum(["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "PTR"])
    .optional()
    .describe("DNS record type (for lookup)"),
})

export const DNSTool = Tool.define("dns_lookup", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["lookup", "reverse", "subdomains", "propagation"]).describe("DNS action to perform"),
      domain: z.string().describe("Domain to query"),
      recordType: z
        .enum(["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "PTR"])
        .optional()
        .describe("DNS record type (for lookup)"),
    }),
    async execute(params) {
      const { execSync } = await import("child_process")
      const isWin = process.platform === "win32"

      let output = ""
      let error = ""

      try {
        switch (params.action) {
          case "lookup": {
            const type = params.recordType || "A"
            const cmd = isWin
              ? `nslookup -type=${type} ${params.domain}`
              : `dig +short ${params.recordType ? `${params.recordType} ` : ""}${params.domain}`
            output = execSync(cmd, { encoding: "utf-8", timeout: 10000 })
            break
          }

          case "reverse": {
            const cmd = isWin ? `nslookup ${params.domain}` : `dig +short -x ${params.domain}`
            output = execSync(cmd, { encoding: "utf-8", timeout: 10000 })
            break
          }

          case "subdomains": {
            const commonSubs = [
              "www",
              "mail",
              "ftp",
              "admin",
              "blog",
              "dev",
              "test",
              "staging",
              "api",
              "cdn",
              "cdn1",
              "static",
              "assets",
              "images",
              "img",
              "shop",
              "store",
              "app",
              "mobile",
              "m",
              "support",
              "help",
              "docs",
              "documentation",
              "wiki",
              "forum",
              "community",
              "gitlab",
              "github",
              "jenkins",
              "ci",
              "build",
              "vpn",
              "proxy",
              "gateway",
              "router",
              "ns1",
              "ns2",
              "dns1",
              "dns2",
            ]

            output = `## Subdomain Enumeration\n\n**Domain**: ${params.domain}\n\n`
            output += `| Subdomain | IP/Result |\n|---------|----------|\n`

            for (const sub of commonSubs) {
              const host = `${sub}.${params.domain}`
              try {
                const cmd = isWin ? `nslookup ${host}` : `dig +short ${host}`
                const result = execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim()
                if (result && !result.includes("can't find")) {
                  output += `| ${host} | ${result.split("\n")[0]} |\n`
                }
              } catch {}
            }
            break
          }

          case "propagation": {
            const servers = [
              { name: "Google (8.8.8.8)", cmd: `dig +short @8.8.8.8 ${params.domain}` },
              { name: "Cloudflare (1.1.1.1)", cmd: `dig +short @1.1.1.1 ${params.domain}` },
              { name: "OpenDNS (208.67.222.222)", cmd: `dig +short @208.67.222.222 ${params.domain}` },
            ]

            output = `## DNS Propagation Check\n\n**Domain**: ${params.domain}\n\n`
            output += `| DNS Server | Result |\n|-----------|--------|\n`

            for (const server of servers) {
              try {
                const result = execSync(server.cmd, { encoding: "utf-8", timeout: 5000 }).trim()
                output += `| ${server.name} | ${result.split("\n")[0] || "No result"} |\n`
              } catch {
                output += `| ${server.name} | Error |\n`
              }
            }
            break
          }
        }
      } catch (err: any) {
        error = err.message
      }

      return {
        title: "DNS Lookup",
        output: error
          ? `Error: ${error}`
          : `## DNS ${params.action.charAt(0).toUpperCase() + params.action.slice(1)}\n\n**Domain**: ${params.domain}\n\n\`\`\`\n${output.trim()}\n\`\`\``,
        metadata: {
          action: "dns_lookup",
          type: params.action,
          domain: params.domain,
          result: error ? "error" : "success",
        },
      }
    },
  }
})
