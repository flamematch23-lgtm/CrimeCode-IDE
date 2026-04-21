import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "List and manage running processes on the system"

const PARAMETERS = z.object({
  action: z.enum(["list", "kill", "info"]).describe("Action to perform"),
  pid: z.number().optional().describe("Process ID (required for kill/info)"),
  filter: z.string().optional().describe("Filter processes by name"),
  limit: z.number().optional().describe("Maximum number of processes to return (default: 20)"),
})

export const ProcessTool = Tool.define("process", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const { execSync } = await import("child_process")
    const isWin = process.platform === "win32"
    let output = ""
    let result = "success"

    try {
      switch (params.action) {
        case "list": {
          const limit = params.limit || 20
          const filter = params.filter || ""
          if (isWin) {
            const cmd = filter
              ? `powershell -Command "Get-Process | Where-Object { $_.Name -like '*${filter}*' } | Sort-Object CPU -Descending | Select-Object -First ${limit} Id, ProcessName, CPU, WorkingSet64, @{N='Memory(MB)';E={[math]::Round($_.WorkingSet64/1MB,2)}} | Format-Table -AutoSize"`
              : `powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First ${limit} Id, ProcessName, CPU, WorkingSet64, @{N='Memory(MB)';E={[math]::Round($_.WorkingSet64/1MB,2)}} | Format-Table -AutoSize"`
            output = execSync(cmd, { encoding: "utf-8", timeout: 10000 })
          } else {
            const cmd = filter
              ? `ps aux | grep -i '${filter}' | grep -v grep | head -${limit}`
              : `ps aux --sort=-%cpu | head -${limit + 1}`
            output = execSync(cmd, { encoding: "utf-8", timeout: 10000 })
          }
          break
        }
        case "kill": {
          if (!params.pid) {
            return {
              title: "Process Manager",
              output: "Error: PID is required for kill action",
              metadata: { action: "process", type: params.action, pid: null, result: "error" },
            }
          }
          const cmd = isWin ? `taskkill /PID ${params.pid} /F` : `kill -9 ${params.pid}`
          output = execSync(cmd, { encoding: "utf-8", timeout: 5000 })
          break
        }
        case "info": {
          if (!params.pid) {
            return {
              title: "Process Manager",
              output: "Error: PID is required for info action",
              metadata: { action: "process", type: params.action, pid: null, result: "error" },
            }
          }
          if (isWin) {
            const cmd = `powershell -Command "Get-Process -Id ${params.pid} | Format-List *"`
            output = execSync(cmd, { encoding: "utf-8", timeout: 5000 })
          } else {
            const cmd = `ps -p ${params.pid} -o pid,ppid,cmd,etime,pcpu,pmem`
            output = execSync(cmd, { encoding: "utf-8", timeout: 5000 })
          }
          break
        }
      }
    } catch (err: any) {
      output = err.stdout || err.message || "Command failed"
      result = "error"
    }

    return {
      title: `Process: ${params.action}`,
      output: `## Process Manager\n\n**Action**: ${params.action}${params.pid ? `\n**PID**: ${params.pid}` : ""}${params.filter ? `\n**Filter**: ${params.filter}` : ""}\n\n\`\`\`\n${output.trim()}\n\`\`\``,
      metadata: { action: "process", type: params.action, pid: params.pid || null, result },
    }
  },
})
