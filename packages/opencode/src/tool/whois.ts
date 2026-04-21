import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Perform WHOIS lookup to gather domain registration and ownership information"

const PARAMETERS = z.object({
  domain: z.string().describe("Domain name to lookup"),
})

export const WHOISTool = Tool.define("whois", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      domain: z.string().describe("Domain name to lookup"),
    }),
    async execute(params) {
      const { execSync } = await import("child_process")
      const isWin = process.platform === "win32"

      let output = ""
      let error = ""

      try {
        const cleanDomain = params.domain.replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0]
        const cmd = isWin ? `whois ${cleanDomain}` : `whois ${cleanDomain}`
        output = execSync(cmd, { encoding: "utf-8", timeout: 15000 })
      } catch (err: any) {
        error = err.message
        try {
          const res = await fetch(`https://rdap.org/domain/${params.domain}`)
          if (res.ok) {
            const data = await res.json()
            output = formatRDAP(data)
          }
        } catch {}
      }

      return {
        title: "WHOIS Lookup",
        output:
          error && !output
            ? `Error: ${error}`
            : `## WHOIS Lookup\n\n**Domain**: ${params.domain}\n\n\`\`\`\n${output.trim()}\n\`\`\``,
        metadata: { action: "whois", domain: params.domain, result: error && !output ? "error" : "success" },
      }
    },
  }
})

function formatRDAP(data: any): string {
  let output = "## RDAP Response\n\n"

  if (data.ldhName) output += `Domain: ${data.ldhName}\n`
  if (data.handle) output += `Handle: ${data.handle}\n`

  output += "\n### Status\n"
  if (data.status) {
    for (const status of data.status) {
      output += `- ${status}\n`
    }
  }

  if (data.nameservers) {
    output += "\n### Nameservers\n"
    for (const ns of data.nameservers) {
      output += `- ${ns.ldhName}\n`
    }
  }

  if (data.events) {
    output += "\n### Important Dates\n"
    for (const event of data.events) {
      output += `- ${event.eventAction}: ${event.eventDate}\n`
    }
  }

  if (data.entities) {
    output += "\n### Registrant Information\n"
    for (const entity of data.entities) {
      if (entity.roles?.includes("registrant")) {
        if (entity.vcardArray) {
          for (const field of entity.vcardArray) {
            if (Array.isArray(field) && field[0] === "fn") {
              output += `Name: ${field[3]}\n`
            }
          }
        }
      }
    }
  }

  return output
}
