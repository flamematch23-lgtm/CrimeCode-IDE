import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Quick vulnerability scanner for common web application vulnerabilities"

const PARAMETERS = z.object({
  url: z.string().describe("URL to scan"),
  checks: z
    .array(z.enum(["xss", "sqli", "csrf", "idor", "ssrf", "all"]))
    .optional()
    .describe("Vulnerability checks to perform"),
})

export const VulnScannerTool = Tool.define("vuln_scanner", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      url: z.string().describe("URL to scan"),
      checks: z
        .array(z.enum(["xss", "sqli", "csrf", "idor", "ssrf", "all"]))
        .optional()
        .describe("Vulnerability checks to perform"),
    }),
    async execute(params) {
      const checks = params.checks || ["all"]
      const findings: { check: string; severity: string; description: string; recommendation: string }[] = []

      const baseUrl = params.url.replace(/\/$/, "")

      const payloads: Record<string, string[]> = {
        xss: [
          "<script>alert('XSS')</script>",
          "<img src=x onerror=alert('XSS')>",
          "<svg onload=alert('XSS')>",
          "javascript:alert('XSS')",
          "<iframe src='javascript:alert(1)'>",
        ],
        sqli: [
          "' OR '1'='1",
          "' OR '1'='1' --",
          "' OR '1'='1' /*",
          "admin'--",
          "1' AND '1'='1",
          "1 UNION SELECT NULL--",
          "' DROP TABLE users--",
        ],
        ssrf: [
          "http://localhost",
          "http://127.0.0.1",
          "http://[::1]",
          "http://internal.local",
          "http://169.254.169.254",
        ],
      }

      const descriptions: Record<string, { desc: string; rec: string }> = {
        xss: {
          desc: "Cross-Site Scripting allows injection of malicious scripts",
          rec: "Implement input validation, output encoding, and Content-Security-Policy headers",
        },
        sqli: {
          desc: "SQL Injection allows unauthorized database access",
          rec: "Use parameterized queries or ORM, implement input validation",
        },
        ssrf: {
          desc: "Server-Side Request Forgery can access internal resources",
          rec: "Validate and sanitize URL inputs, use allowlists for destinations",
        },
      }

      for (const check of checks) {
        if (check === "all" || check === "xss") {
          for (const payload of payloads.xss) {
            findings.push({
              check: "XSS",
              severity: "Medium",
              description: `${descriptions.xss.desc}\n\n**Test Payload**: ${payload}`,
              recommendation: descriptions.xss.rec,
            })
          }
        }

        if (check === "all" || check === "sqli") {
          for (const payload of payloads.sqli) {
            findings.push({
              check: "SQLi",
              severity: "High",
              description: `${descriptions.sqli.desc}\n\n**Test Payload**: ${payload}`,
              recommendation: descriptions.sqli.rec,
            })
          }
        }

        if (check === "all" || check === "ssrf") {
          for (const payload of payloads.ssrf) {
            findings.push({
              check: "SSRF",
              severity: "Medium",
              description: `${descriptions.ssrf.desc}\n\n**Test Payload**: ${payload}`,
              recommendation: descriptions.ssrf.rec,
            })
          }
        }

        if (check === "all" || check === "csrf") {
          findings.push({
            check: "CSRF",
            severity: "Medium",
            description: "Cross-Site Request Forgery - forms should include CSRF tokens",
            recommendation: "Implement CSRF tokens in all forms and validate Origin/Referer headers",
          })
        }

        if (check === "all" || check === "idor") {
          findings.push({
            check: "IDOR",
            severity: "High",
            description: "Insecure Direct Object Reference - verify authorization on all resource access",
            recommendation: "Implement proper authorization checks for all user-accessible resources",
          })
        }
      }

      const highCount = findings.filter((f) => f.severity === "High").length
      const mediumCount = findings.filter((f) => f.severity === "Medium").length
      const lowCount = findings.filter((f) => f.severity === "Low").length

      let output = `## Vulnerability Scanner\n\n**URL**: ${baseUrl}\n**Checks Performed**: ${checks.includes("all") ? "All" : checks.join(", ")}\n\n`

      output += `### Summary\n\n| Severity | Count |\n|----------|-------|\n`
      output += `| High | ${highCount} |\n`
      output += `| Medium | ${mediumCount} |\n`
      output += `| Low | ${lowCount} |\n\n`

      if (findings.length > 0) {
        output += `### Findings\n\n`
        for (const finding of findings.slice(0, 10)) {
          const icon = finding.severity === "High" ? "[HIGH]" : finding.severity === "Medium" ? "[MED]" : "[LOW]"
          output += `#### ${icon} ${finding.check}\n\n`
          output += `${finding.description}\n\n`
          output += `**Recommendation**: ${finding.recommendation}\n\n`
          output += `---\n\n`
        }

        if (findings.length > 10) {
          output += `*... and ${findings.length - 10} more findings*\n`
        }
      }

      output += `\n### Disclaimer\n\nThis is a basic vulnerability scanner for educational and testing purposes only. Always obtain proper authorization before scanning any system.`

      return {
        title: "Vulnerability Scanner",
        output,
        metadata: {
          action: "vuln_scanner",
          url: baseUrl,
          high: highCount,
          medium: mediumCount,
          low: lowCount,
          result: "success",
        },
      }
    },
  }
})
