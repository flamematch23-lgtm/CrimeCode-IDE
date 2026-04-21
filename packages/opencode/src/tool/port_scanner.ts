import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Scan network ports on a target host to identify open services"

const PARAMETERS = z.object({
  target: z.string().describe("Target host or IP address"),
  ports: z.string().optional().describe("Ports to scan (e.g., '22,80,443', '1-1000', 'common')"),
  timeout: z.number().optional().describe("Timeout per port in ms (default: 1000)"),
})

export const PortScannerTool = Tool.define("port_scanner", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const { execSync } = await import("child_process")
    const isWin = process.platform === "win32"

    const commonPorts: Record<number, string> = {
      21: "FTP",
      22: "SSH",
      23: "Telnet",
      25: "SMTP",
      53: "DNS",
      80: "HTTP",
      110: "POP3",
      143: "IMAP",
      443: "HTTPS",
      445: "SMB",
      993: "IMAPS",
      995: "POP3S",
      1433: "MSSQL",
      1521: "Oracle",
      3306: "MySQL",
      3389: "RDP",
      5432: "PostgreSQL",
      5900: "VNC",
      6379: "Redis",
      8080: "HTTP-Alt",
      8443: "HTTPS-Alt",
      27017: "MongoDB",
    }

    let portsToScan: number[] = []

    if (!params.ports || params.ports === "common") {
      portsToScan = Object.keys(commonPorts).map(Number)
    } else if (params.ports.includes("-")) {
      const [start, end] = params.ports.split("-").map(Number)
      portsToScan = Array.from({ length: end - start + 1 }, (_, i) => start + i)
    } else {
      portsToScan = params.ports.split(",").map((p) => parseInt(p.trim()))
    }

    const timeout = params.timeout || 1000
    const openPorts: { port: number; service: string }[] = []
    const checkedPorts: number[] = []

    for (const port of portsToScan.slice(0, 100)) {
      checkedPorts.push(port)
      try {
        if (isWin) {
          const cmd = `powershell -Command "$result = Test-NetConnection -ComputerName '${params.target}' -Port ${port} -WarningAction SilentlyContinue; if ($result.TcpTestSucceeded) { 'OPEN' }"`
          const result = execSync(cmd, { encoding: "utf-8", timeout: Math.ceil(timeout / 500) }).trim()
          if (result === "OPEN") {
            openPorts.push({ port, service: commonPorts[port] || "Unknown" })
          }
        } else {
          const cmd = `timeout ${timeout / 1000}s bash -c "echo > /dev/tcp/${params.target}/${port}" 2>/dev/null && echo "OPEN"`
          const result = execSync(cmd, { encoding: "utf-8", timeout }).trim()
          if (result === "OPEN") {
            openPorts.push({ port, service: commonPorts[port] || "Unknown" })
          }
        }
      } catch {}
    }

    let output = `## Port Scan Results\n\n**Target**: ${params.target}
**Ports Checked**: ${checkedPorts.length}
**Open Ports Found**: ${openPorts.length}\n\n`

    if (openPorts.length > 0) {
      output += "| Port | Service | Status |\n|------|---------|--------|\n"
      for (const { port, service } of openPorts) {
        output += `| ${port} | ${service} | OPEN |\n`
      }
    } else {
      output += "No open ports found in the scanned range."
    }

    return {
      title: "Port Scanner",
      output,
      metadata: {
        action: "port_scanner",
        target: params.target,
        openPorts: openPorts.length,
        totalScanned: checkedPorts.length,
      },
    }
  },
})
