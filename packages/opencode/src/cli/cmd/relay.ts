import type { Argv } from "yargs"
import { spawn } from "child_process"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { startRelay } from "../../share/relay"

const RelayStartCommand = cmd({
  command: "start",
  describe: "start a relay server (for WAN/internet live share)",
  builder: (yargs: Argv) =>
    yargs.option("port", {
      type: "number",
      describe: "port to listen on",
      default: Number(process.env.RELAY_PORT) || 3747,
    }),
  async handler(argv) {
    const r = startRelay({ port: argv.port as number })
    UI.println("")
    UI.println(UI.Style.TEXT_HIGHLIGHT + "OpenCode Relay Server" + UI.Style.TEXT_NORMAL)
    UI.println(UI.Style.TEXT_DIM + `WebSocket: ws://0.0.0.0:${r.port}` + UI.Style.TEXT_NORMAL)
    UI.println(UI.Style.TEXT_DIM + `HTTP:      http://0.0.0.0:${r.port}` + UI.Style.TEXT_NORMAL)
    UI.println("")
    UI.println("Share with: opencode share start --relay ws://YOUR_PUBLIC_HOST:" + r.port)
    UI.println("")
    await new Promise(() => {})
  },
})

const RelayTunnelCommand = cmd({
  command: "tunnel",
  describe: "start relay + Cloudflare quick tunnel for instant public WAN access",
  builder: (yargs: Argv) =>
    yargs
      .option("port", {
        type: "number",
        describe: "local port for the relay",
        default: Number(process.env.RELAY_PORT) || 3747,
      })
      .option("bin", {
        type: "string",
        describe: "path to cloudflared binary",
        default: "cloudflared",
      }),
  async handler(argv) {
    const port = argv.port as number
    const bin = argv.bin as string
    const r = startRelay({ port })
    UI.println("")
    UI.println(UI.Style.TEXT_HIGHLIGHT + "Relay started on port " + r.port + UI.Style.TEXT_NORMAL)
    UI.println(UI.Style.TEXT_DIM + "Spawning cloudflared quick tunnel..." + UI.Style.TEXT_NORMAL)
    UI.println("")

    const child = spawn(bin, ["tunnel", "--url", `http://localhost:${r.port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
    let printed = false
    const handle = (chunk: Buffer) => {
      const text = chunk.toString()
      const m = text.match(re)
      if (m && !printed) {
        printed = true
        const https = m[0]
        const wss = https.replace(/^https:/, "wss:")
        UI.println("")
        UI.println(UI.Style.TEXT_HIGHLIGHT + "Public relay ready!" + UI.Style.TEXT_NORMAL)
        UI.println(UI.Style.TEXT_DIM + `URL: ${https}` + UI.Style.TEXT_NORMAL)
        UI.println("")
        UI.println("Use it with:")
        UI.println(`  opencode share start --relay ${wss}`)
        UI.println("")
      }
      process.stderr.write(text)
    }
    child.stdout?.on("data", handle)
    child.stderr?.on("data", handle)

    child.on("exit", (code) => {
      UI.println(UI.Style.TEXT_DIM + `[cloudflared exited code=${code}]` + UI.Style.TEXT_NORMAL)
      r.stop()
      process.exit(code ?? 0)
    })

    process.on("SIGINT", () => {
      child.kill()
      r.stop()
      process.exit(0)
    })

    await new Promise(() => {})
  },
})

const RelayStatsCommand = cmd({
  command: "stats",
  describe: "print stats for a running relay (via HTTP /health)",
  builder: (yargs: Argv) =>
    yargs.option("url", {
      type: "string",
      describe: "relay http url",
      default: "http://localhost:3747",
    }),
  async handler(argv) {
    const url = (argv.url as string).replace(/\/$/, "") + "/health"
    const res = await fetch(url)
    const json = await res.json()
    UI.println(JSON.stringify(json, null, 2))
  },
})

export const RelayCommand = cmd({
  command: "relay",
  describe: "run a relay server for WAN live share",
  builder: (yargs: Argv) =>
    yargs.command(RelayStartCommand).command(RelayTunnelCommand).command(RelayStatsCommand).demandCommand(),
  async handler() {},
})
