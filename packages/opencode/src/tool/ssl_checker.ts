import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Check SSL/TLS certificate details of a server"

export const SSLCheckerTool = Tool.define("ssl_checker", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      host: z.string().describe("Hostname to check (e.g., 'example.com' or 'example.com:443')"),
      timeout: z.number().optional().describe("Connection timeout in ms (default: 10000)"),
    }),
    async execute(params) {
      const [hostname, portStr] = params.host.split(":")
      const port = parseInt(portStr) || 443
      const timeout = params.timeout || 10000
      let status = "error"
      let output = ""

      try {
        const tls = await import("tls")

        const cert = await new Promise<any>((resolve, reject) => {
          const socket = tls.connect(port, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
            const c = socket.getPeerCertificate()
            socket.destroy()
            resolve(c)
          })
          socket.setTimeout(timeout, () => {
            socket.destroy()
            reject(new Error("timeout"))
          })
          socket.on("error", reject)
        })

        if (!cert || Object.keys(cert).length === 0) {
          status = "no_cert"
          output = `No certificate found for ${hostname}:${port}`
        } else {
          status = "valid"
          const validFrom = new Date(cert.valid_from)
          const validTo = new Date(cert.valid_to)
          const now = new Date()
          const daysUntilExpiry = Math.ceil((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          const isExpired = validTo < now
          const isExpiringSoon = daysUntilExpiry <= 30

          output = `## SSL/TLS Certificate Check\n\n**Host**: ${hostname}:${port}
**Status**: ${isExpired ? "EXPIRED" : isExpiringSoon ? "EXPIRING SOON" : "VALID"}\n\n`
          output += `### Certificate Details\n\n`
          output += `| Field | Value |\n|------|-------|\n`
          output += `| Subject | ${cert.subject?.CN || "N/A"} |\n`
          output += `| Issuer | ${cert.issuer?.O || "N/A"} |\n`
          output += `| Valid From | ${validFrom.toISOString()} |\n`
          output += `| Valid Until | ${validTo.toISOString()} |\n`
          output += `| Days Until Expiry | ${daysUntilExpiry} |\n`
          output += `| Serial Number | ${cert.serialNumber || "N/A"} |\n`
          output += `| Fingerprint (SHA1) | ${cert.fingerprint || "N/A"} |\n`
        }
      } catch (err: any) {
        status = err.message === "timeout" ? "timeout" : "error"
        output = `Error: ${err.message}`
      }

      return {
        title: "SSL Checker",
        output,
        metadata: { action: "ssl_checker", result: status, host: hostname, port },
      }
    },
  }
})
