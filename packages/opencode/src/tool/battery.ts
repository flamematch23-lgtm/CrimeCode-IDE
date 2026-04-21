import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Get battery status and information"

const PARAMETERS = z.object({
  detail: z.boolean().optional().describe("Show detailed information (default: false)"),
})

export const BatteryTool = Tool.define("battery", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const isWin = process.platform === "win32"

    if (!isWin) {
      try {
        const { execSync } = await import("child_process")
        const output = execSync(
          "upower -i /org/freedesktop/UPower/devices/battery_BAT0 2>/dev/null || upower -i $(upower -e | grep battery | head -1)",
          { encoding: "utf-8", timeout: 5000 },
        )

        const parseLine = (line: string) => {
          const [key, ...valueParts] = line.split(/\s*:\s*/)
          return { key: key.trim(), value: valueParts.join(":").trim() }
        }

        const lines = output.split("\n").map(parseLine)
        const get = (key: string) =>
          lines.find((l) => l.key.toLowerCase().includes(key.toLowerCase()))?.value || "Unknown"

        const state = get("state")
        const percentage = get("percentage")
        const time = get("time")
        const plugged = get("percentage")

        return {
          title: "Battery Status",
          output: `## Battery Status\n\n**State**: ${state}
**Percentage**: ${percentage}
${time !== "Unknown" ? `**Time Remaining**: ${time}` : ""}`,
          metadata: { action: "battery", result: "success", state, percentage },
        }
      } catch {
        return {
          title: "Battery Status",
          output: "Battery information not available on this system",
          metadata: { action: "battery", result: "unavailable" },
        }
      }
    }

    try {
      const { execSync } = await import("child_process")
      const script = `
$pcap = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
if ($pcap) {
  $status = switch ($pcap.BatteryStatus) {
    1 { "Discharging" }
    2 { "On AC Power" }
    3 { "Fully Charged" }
    4 { "Low" }
    5 { "Critical" }
    default { "Unknown" }
  }
  $est = if ($pcap.EstimatedChargeRemaining -lt 100) { "$($pcap.EstimatedChargeRemaining)%" } else { "N/A" }
  $time = if ($pcap.EstimatedRunTime -and $pcap.EstimatedRunTime -lt 71582788) { "$([math]::Floor($pcap.EstimatedRunTime / 60)) min" } else { "Calculating..." }
  @{
    State = $status
    Percentage = $est
    TimeRemaining = $time
    Voltage = "$($pcap.DesignVoltage) mV"
    Chemistry = $pcap.Chemistry
  } | ConvertTo-Json
} else {
  '{"error": "No battery detected"}'
}
`
      const output = execSync(`powershell -Command "${script}"`, { encoding: "utf-8", timeout: 10000 })
      const data = JSON.parse(output)

      if (data.error) {
        return {
          title: "Battery Status",
          output: "No battery detected on this system",
          metadata: { action: "battery", result: "no_battery" },
        }
      }

      const output_text = params.detail
        ? `## Battery Status\n\n**State**: ${data.State}
**Percentage**: ${data.Percentage}
**Time Remaining**: ${data.TimeRemaining}
**Voltage**: ${data.Voltage}
**Chemistry**: ${data.Chemistry}`
        : `## Battery Status\n\n**State**: ${data.State}
**Percentage**: ${data.Percentage}
**Time Remaining**: ${data.TimeRemaining}`

      return {
        title: "Battery Status",
        output: output_text,
        metadata: { action: "battery", result: "success", state: data.State, percentage: data.Percentage },
      }
    } catch (err: any) {
      return {
        title: "Battery Status",
        output: `Error: ${err.message}`,
        metadata: { action: "battery", result: "error" },
      }
    }
  },
})
