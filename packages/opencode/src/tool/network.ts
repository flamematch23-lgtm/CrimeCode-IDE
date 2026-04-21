import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Execute network diagnostic commands like ping, DNS lookup, and port checks"

const PARAMETERS = z.object({
  action: z.enum(["ping", "dns", "port-check", "traceroute"]).describe("Network action to perform"),
  host: z.string().describe("Host or IP address to check"),
  count: z.number().optional().describe("Number of ping packets (default: 4)"),
  port: z.number().optional().describe("Port number for port-check"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default: 5000)"),
})

export const NetworkTool = Tool.define("network", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const { execSync } = await import("child_process")
    const isWin = process.platform === "win32"
    let output = ""

    try {
      switch (params.action) {
        case "ping": {
          const count = params.count || 4
          const timeout = params.timeout || 5000
          const cmd = isWin
            ? `ping -n ${count} -w ${timeout} ${params.host}`
            : `ping -c ${count} -W ${Math.ceil(timeout / 1000)} ${params.host}`
          output = execSync(cmd, { encoding: "utf-8", timeout: timeout * count + 10000 })
          break
        }
        case "dns": {
          const cmd = isWin ? `nslookup ${params.host}` : `dig +short ${params.host}`
          output = execSync(cmd, { encoding: "utf-8", timeout: 10000 })
          break
        }
        case "port-check": {
          const port = params.port || 80
          const timeout = params.timeout || 5000
          const cmd = isWin
            ? `powershell -Command "Test-NetConnection -ComputerName ${params.host} -Port ${port} | Select-Object -Property ComputerName,RemotePort,TcpTestSucceeded | Format-List"`
            : `timeout ${timeout / 1000}s bash -c "echo > /dev/tcp/${params.host}/${port}" 2>/dev/null && echo "Port ${port} is OPEN" || echo "Port ${port} is CLOSED"`
          output = execSync(cmd, { encoding: "utf-8", timeout })
          break
        }
        case "traceroute": {
          const cmd = isWin ? `tracert ${params.host}` : `traceroute ${params.host}`
          output = execSync(cmd, { encoding: "utf-8", timeout: 30000 })
          break
        }
      }
    } catch (err: any) {
      output = err.stdout || err.message
    }

    return {
      title: `Network: ${params.action}`,
      output: `## Network ${params.action.charAt(0).toUpperCase() + params.action.slice(1)}\n\n**Host**: ${params.host}${params.port ? `\n**Port**: ${params.port}` : ""}\n\n\`\`\`\n${output.trim()}\n\`\`\``,
      metadata: { action: "network", type: params.action, host: params.host },
    }
  },
})
