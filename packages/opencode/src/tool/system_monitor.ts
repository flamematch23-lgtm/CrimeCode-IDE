import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Monitor system resources like CPU, memory, and disk usage"

const PARAMETERS = z.object({
  type: z.enum(["cpu", "memory", "disk", "all"]).describe("Type of system information to retrieve"),
})

export const SystemMonitorTool = Tool.define("system_monitor", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const os = await import("os")

    const cpuUsage = () => {
      const cpus = os.cpus()
      const totalIdle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0)
      const totalTick = cpus.reduce((acc, cpu) => acc + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0)
      return ((1 - totalIdle / totalTick) * 100).toFixed(1)
    }

    const memUsage = () => {
      const total = os.totalmem()
      const free = os.freemem()
      const used = total - free
      return {
        total: (total / 1024 / 1024 / 1024).toFixed(2),
        used: (used / 1024 / 1024 / 1024).toFixed(2),
        free: (free / 1024 / 1024 / 1024).toFixed(2),
        percent: ((used / total) * 100).toFixed(1),
      }
    }

    const diskUsage = async () => {
      if (process.platform === "win32") {
        const drive = process.env.SYSTEMDRIVE || "C:"
        try {
          const { execSync } = await import("child_process")
          const output = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get Size,FreeSpace /format:value`, {
            encoding: "utf-8",
          })
          const freeMatch = output.match(/FreeSpace=(\d+)/)
          const sizeMatch = output.match(/Size=(\d+)/)
          if (freeMatch && sizeMatch) {
            const free = parseInt(freeMatch[1]) / 1024 / 1024 / 1024
            const total = parseInt(sizeMatch[1]) / 1024 / 1024 / 1024
            return {
              drive,
              total: total.toFixed(2),
              free: free.toFixed(2),
              used: (total - free).toFixed(2),
              percent: (((total - free) / total) * 100).toFixed(1),
            }
          }
        } catch {}
      }
      return null
    }

    const formatUptime = (seconds: number) => {
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const mins = Math.floor((seconds % 3600) / 60)
      return `${days}d ${hours}h ${mins}m`
    }

    const info = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: formatUptime(os.uptime()),
      loadavg: os.loadavg(),
      cpuCount: os.cpus().length,
    }

    let output = ""

    switch (params.type) {
      case "cpu":
        output = `## CPU Usage\n\n- **Usage**: ${cpuUsage()}%
- **Cores**: ${info.cpuCount}
- **Load Average**: ${info.loadavg.map((l) => l.toFixed(2)).join(", ")}
- **Architecture**: ${info.arch}`
        break
      case "memory":
        const mem = memUsage()
        output = `## Memory Usage\n\n- **Total**: ${mem.total} GB
- **Used**: ${mem.used} GB
- **Free**: ${mem.free} GB
- **Usage**: ${mem.percent}%`
        break
      case "disk":
        const disk = await diskUsage()
        if (disk) {
          output = `## Disk Usage (${disk.drive})\n\n- **Total**: ${disk.total} GB
- **Used**: ${disk.used} GB
- **Free**: ${disk.free} GB
- **Usage**: ${disk.percent}%`
        } else {
          output = "Unable to retrieve disk usage information"
        }
        break
      case "all":
        const memAll = memUsage()
        const diskAll = await diskUsage()
        output = `## System Monitor\n\n**Host**: ${info.hostname}
**Platform**: ${info.platform} (${info.arch})
**Uptime**: ${info.uptime}\n\n### CPU
- **Usage**: ${cpuUsage()}%
- **Cores**: ${info.cpuCount}
- **Load Average**: ${info.loadavg.map((l) => l.toFixed(2)).join(", ")}\n\n### Memory
- **Total**: ${memAll.total} GB
- **Used**: ${memAll.used} GB
- **Free**: ${memAll.free} GB
- **Usage**: ${memAll.percent}%`
        if (diskAll) {
          output += `\n\n### Disk (${diskAll.drive})
- **Total**: ${diskAll.total} GB
- **Used**: ${diskAll.used} GB
- **Free**: ${diskAll.free} GB
- **Usage**: ${diskAll.percent}%`
        }
        break
    }

    return {
      title: "System Monitor",
      output,
      metadata: { action: "system_monitor", type: params.type },
    }
  },
})
