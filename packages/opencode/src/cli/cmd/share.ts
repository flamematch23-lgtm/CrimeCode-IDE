import type { Argv } from "yargs"
import * as readline from "readline"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { LiveShare } from "../../share/live"

const ShareStartCommand = cmd({
  command: "start",
  describe: "start a live share session (host)",
  builder: (yargs: Argv) =>
    yargs
      .option("port", {
        type: "number",
        describe: "port for the share server — LAN mode only (default: random)",
        default: 0,
      })
      .option("hostname", {
        type: "string",
        describe: "hostname to bind to — LAN mode only",
        default: "0.0.0.0",
      })
      .option("relay", {
        type: "string",
        describe: "relay server URL for internet sharing (e.g. ws://relay.example.com:3747)",
      })
      .option("token", {
        type: "string",
        describe: "join token — only users with this token can join (relay mode only)",
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const relay = args.relay ?? process.env.CRIMECODE_RELAY_URL
      // LAN mode was removed — port/hostname args are accepted by the CLI
      // for backwards-compat but ignored here. Relay is required.
      const result = await LiveShare.start({
        relay,
        token: args.token,
      })

      UI.println("")
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Live share session started!" + UI.Style.TEXT_NORMAL)
      UI.println("")
      UI.println("  Code:  " + UI.Style.TEXT_HIGHLIGHT + result.code + UI.Style.TEXT_NORMAL)

      if (result.relay) {
        UI.println("  Mode:  " + UI.Style.TEXT_DIM + "relay  (" + result.relay + ")" + UI.Style.TEXT_NORMAL)
        if (result.locked) {
          UI.println("  Lock:  " + UI.Style.TEXT_WARNING + "token-locked" + UI.Style.TEXT_NORMAL)
        }
        UI.println("")
        const tokenFlag = result.locked && args.token ? ` --token ${args.token}` : ""
        UI.println("Anyone can join from any network with:")
        UI.println(
          "  " +
            UI.Style.TEXT_HIGHLIGHT +
            `crimecode share join --relay ${result.relay} --code ${result.code}${tokenFlag}` +
            UI.Style.TEXT_NORMAL,
        )
      } else {
        UI.println("  Mode:  " + UI.Style.TEXT_DIM + "LAN" + UI.Style.TEXT_NORMAL)
        UI.println("  Addr:  " + UI.Style.TEXT_DIM + `${result.hostname}:${result.port}` + UI.Style.TEXT_NORMAL)
        UI.println("")
        UI.println("Partners on the same network can join with:")
        UI.println(
          "  " +
            UI.Style.TEXT_HIGHLIGHT +
            `crimecode share join --host ${result.hostname} --port ${result.port} --code ${result.code}` +
            UI.Style.TEXT_NORMAL,
        )
      }

      UI.println("")
      UI.println(UI.Style.TEXT_DIM + "Press Ctrl+C to stop sharing" + UI.Style.TEXT_NORMAL)

      // Keep alive
      await new Promise(() => {})
    })
  },
})

const ShareJoinCommand = cmd({
  command: "join",
  describe: "join a live share session (participant)",
  builder: (yargs: Argv) =>
    yargs
      .option("relay", {
        type: "string",
        describe: "relay server URL — use instead of --host/--port for internet sessions",
      })
      .option("host", {
        type: "string",
        describe: "host address (LAN mode)",
      })
      .option("port", {
        type: "number",
        describe: "port (LAN mode)",
      })
      .option("code", {
        type: "string",
        describe: "share session code",
        demandOption: true,
      })
      .option("name", {
        type: "string",
        describe: "display name to use in the session",
      })
      .option("token", {
        type: "string",
        describe: "join token for token-locked sessions",
      }),
  handler: async (args) => {
    const relay = args.relay ?? process.env.CRIMECODE_RELAY_URL
    const mode = relay ? `relay (${relay})` : `${args.host}:${args.port}`

    UI.println("")
    UI.println(UI.Style.TEXT_DIM + `Connecting via ${mode}...` + UI.Style.TEXT_NORMAL)

    try {
      let result!: { id: string; name: string }

      result = await LiveShare.join({
        relay,
        code: args.code,
        name: args.name,
        token: args.token,
        onMessage(msg) {
          const ts = new Date().toLocaleTimeString()
          if (msg.type === "chat") {
            const who =
              msg.name === result?.name ? UI.Style.TEXT_SUCCESS_BOLD + "you" : UI.Style.TEXT_HIGHLIGHT + msg.name
            UI.println(`[${ts}] ${who}${UI.Style.TEXT_NORMAL}: ${msg.text}`)
          } else if (msg.type === "file_content") {
            const lines = msg.content.split("\n").length
            UI.println(
              UI.Style.TEXT_DIM + `[${ts}] [sync] ${msg.event}: ${msg.file} (${lines} lines)` + UI.Style.TEXT_NORMAL,
            )
          } else if (msg.type === "file") {
            UI.println(UI.Style.TEXT_DIM + `[${ts}] [file] ${msg.event}: ${msg.file}` + UI.Style.TEXT_NORMAL)
          } else if (msg.type === "joined") {
            UI.println(UI.Style.TEXT_SUCCESS_BOLD + `[${ts}] + ${msg.name} joined` + UI.Style.TEXT_NORMAL)
          } else if (msg.type === "left") {
            UI.println(UI.Style.TEXT_WARNING + `[${ts}] - ${msg.name} left` + UI.Style.TEXT_NORMAL)
          } else if (msg.type === "participants") {
            UI.println(
              UI.Style.TEXT_DIM +
                `[${ts}] Participants: ${msg.list.map((p) => p.name).join(", ")}` +
                UI.Style.TEXT_NORMAL,
            )
          } else if (msg.type === "event") {
            UI.println(
              UI.Style.TEXT_DIM + `[${ts}] [event] ${JSON.stringify(msg.payload).slice(0, 120)}` + UI.Style.TEXT_NORMAL,
            )
          }
        },
        onClose(reason) {
          UI.println("")
          UI.println(UI.Style.TEXT_WARNING + `Disconnected: ${reason}` + UI.Style.TEXT_NORMAL)
          process.exit(0)
        },
      })

      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Connected as ${result.name} (${result.id})` + UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_DIM + "Type a message and press Enter to chat. Ctrl+C to leave." + UI.Style.TEXT_NORMAL)
      UI.println("")

      // Interactive chat input
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
      rl.on("line", (line) => {
        const text = line.trim()
        if (!text) return
        try {
          LiveShare.chat(text)
        } catch {
          // connection dropped
        }
      })
      rl.on("close", () => process.exit(0))

      // Keep alive
      await new Promise(() => {})
    } catch (e: any) {
      UI.error(`Failed to join: ${e.message}`)
      process.exit(1)
    }
  },
})

const ShareKickCommand = cmd({
  command: "kick <id>",
  describe: "kick a participant from the live share session",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { type: "string", describe: "participant ID to kick", demandOption: true })
      .option("reason", { type: "string", describe: "reason for kicking", default: "kicked by host" }),
  handler: async (args) => {
    try {
      LiveShare.kick(args.id, args.reason)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Kicked participant ${args.id}` + UI.Style.TEXT_NORMAL)
    } catch (e: any) {
      UI.error(e.message)
      process.exit(1)
    }
  },
})

const ShareStopCommand = cmd({
  command: "stop",
  describe: "stop the live share session",
  handler: async () => {
    try {
      LiveShare.stop()
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Live share session stopped" + UI.Style.TEXT_NORMAL)
    } catch (e: any) {
      UI.error(e.message)
      process.exit(1)
    }
  },
})

const ShareListCommand = cmd({
  command: "list",
  describe: "list participants in the live share session",
  handler: async () => {
    const h = LiveShare.active()
    if (!h) {
      UI.error("No active live share session")
      process.exit(1)
    }
    const list = LiveShare.listParticipants()
    UI.println("")
    UI.println(UI.Style.TEXT_HIGHLIGHT + `Share Code: ${h.code}` + UI.Style.TEXT_NORMAL)
    if (h.relay) {
      UI.println(UI.Style.TEXT_DIM + `Mode: relay (${h.relay})` + UI.Style.TEXT_NORMAL)
    } else {
      UI.println(UI.Style.TEXT_DIM + `Address: ${h.hostname}:${h.port}` + UI.Style.TEXT_NORMAL)
    }
    UI.println("")
    if (list.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No participants connected" + UI.Style.TEXT_NORMAL)
    } else {
      UI.println("Participants:")
      for (const p of list) {
        const elapsed = Math.round((Date.now() - p.joined) / 1000)
        UI.println(`  ${p.id}  ${p.name}  (joined ${elapsed}s ago)`)
      }
    }
    UI.println("")
  },
})

export const ShareCommand = cmd({
  command: "share",
  describe: "live session sharing with real-time collaboration",
  builder: (yargs: Argv) =>
    yargs
      .command(ShareStartCommand)
      .command(ShareJoinCommand)
      .command(ShareKickCommand)
      .command(ShareStopCommand)
      .command(ShareListCommand)
      .demandCommand(),
  async handler() {},
})
