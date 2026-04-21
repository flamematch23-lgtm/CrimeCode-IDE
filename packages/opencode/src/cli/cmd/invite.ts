import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { resolve } from "../../server/routes/invite"

const InviteCreateCommand = cmd({
  command: "create",
  describe: "create a workspace invite code for remote collaboration",
  builder: (yargs: Argv) =>
    yargs
      .option("relay", {
        type: "string",
        describe: "relay server URL (e.g. http://relay.example.com:3747)",
        demandOption: true,
      })
      .option("url", {
        type: "string",
        describe: "public URL of your OpenCode server (e.g. http://your-ip:4096)",
        demandOption: true,
      })
      .option("token", {
        type: "string",
        describe: "optional join token for extra security",
      })
      .option("password", {
        type: "string",
        describe: "server password (for authenticated servers)",
      }),
  handler: async (args) => {
    const relay = args.relay
    const headers: Record<string, string> = { "content-type": "application/json" }
    const admin = process.env.CRIMECODE_RELAY_ADMIN_TOKEN
    if (admin) headers["authorization"] = `Bearer ${admin}`

    try {
      const res = await fetch(`${relay}/invite`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: args.url,
          token: args.token,
          password: args.password,
        }),
      })
      if (!res.ok) {
        UI.error(`Failed to create invite: ${res.status} ${await res.text()}`)
        process.exit(1)
      }
      const data = (await res.json()) as { code: string; expires: number }
      const remaining = Math.round((data.expires - Date.now()) / 60000)

      UI.println("")
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Workspace invite created!" + UI.Style.TEXT_NORMAL)
      UI.println("")
      UI.println("  Code:     " + UI.Style.TEXT_HIGHLIGHT + data.code + UI.Style.TEXT_NORMAL)
      UI.println("  Relay:    " + UI.Style.TEXT_DIM + relay + UI.Style.TEXT_NORMAL)
      UI.println("  Expires:  " + UI.Style.TEXT_DIM + `${remaining} minutes` + UI.Style.TEXT_NORMAL)
      UI.println("")
      UI.println("Share this with your partner:")
      UI.println(
        "  " +
          UI.Style.TEXT_HIGHLIGHT +
          `crimecode invite join --relay ${relay} --code ${data.code}` +
          UI.Style.TEXT_NORMAL,
      )
      UI.println("")
    } catch (e: any) {
      UI.error(`Failed to create invite: ${e.message}`)
      process.exit(1)
    }
  },
})

const InviteJoinCommand = cmd({
  command: "join",
  describe: "join a workspace using an invite code",
  builder: (yargs: Argv) =>
    yargs
      .option("relay", {
        type: "string",
        describe: "relay server URL",
        demandOption: true,
      })
      .option("code", {
        type: "string",
        describe: "invite code received from the host",
        demandOption: true,
      }),
  handler: async (args) => {
    const relay = args.relay
    const code = args.code.toUpperCase()

    UI.println("")
    UI.println(UI.Style.TEXT_DIM + `Resolving invite ${code}...` + UI.Style.TEXT_NORMAL)

    try {
      const result = await resolve(relay, code)

      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Invite resolved!" + UI.Style.TEXT_NORMAL)
      UI.println("")
      UI.println("  Server:  " + UI.Style.TEXT_HIGHLIGHT + result.url + UI.Style.TEXT_NORMAL)
      if (result.token) {
        UI.println("  Token:   " + UI.Style.TEXT_DIM + "(included)" + UI.Style.TEXT_NORMAL)
      }
      UI.println("")
      UI.println("Connect with:")
      const cmd = result.token
        ? `crimecode attach ${result.url} --password ${result.token}`
        : `crimecode attach ${result.url}`
      UI.println("  " + UI.Style.TEXT_HIGHLIGHT + cmd + UI.Style.TEXT_NORMAL)
      UI.println("")
      UI.println("Or add the server in the desktop app:")
      UI.println("  " + UI.Style.TEXT_DIM + `Address: ${result.url}` + UI.Style.TEXT_NORMAL)
      UI.println("")
    } catch (e: any) {
      UI.error(`Failed to resolve invite: ${e.message}`)
      process.exit(1)
    }
  },
})

const InviteRevokeCommand = cmd({
  command: "revoke",
  describe: "revoke an active invite code",
  builder: (yargs: Argv) =>
    yargs
      .option("relay", {
        type: "string",
        describe: "relay server URL",
        demandOption: true,
      })
      .option("code", {
        type: "string",
        describe: "invite code to revoke",
        demandOption: true,
      }),
  handler: async (args) => {
    const relay = args.relay
    const code = args.code.toUpperCase()
    const headers: Record<string, string> = {}
    const admin = process.env.CRIMECODE_RELAY_ADMIN_TOKEN
    if (admin) headers["authorization"] = `Bearer ${admin}`

    try {
      const res = await fetch(`${relay}/invite/${code}`, {
        method: "DELETE",
        headers,
      })
      if (!res.ok) {
        UI.error(`Failed to revoke: ${res.status} ${await res.text()}`)
        process.exit(1)
      }
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Invite ${code} revoked` + UI.Style.TEXT_NORMAL)
    } catch (e: any) {
      UI.error(`Failed to revoke invite: ${e.message}`)
      process.exit(1)
    }
  },
})

const InviteListCommand = cmd({
  command: "list",
  describe: "list active invites on a relay",
  builder: (yargs: Argv) =>
    yargs.option("relay", {
      type: "string",
      describe: "relay server URL",
      demandOption: true,
    }),
  handler: async (args) => {
    const relay = args.relay
    const headers: Record<string, string> = {}
    const admin = process.env.CRIMECODE_RELAY_ADMIN_TOKEN
    if (admin) headers["authorization"] = `Bearer ${admin}`

    try {
      const res = await fetch(`${relay}/invite`, { headers })
      if (!res.ok) {
        UI.error(`Failed to list invites: ${res.status} ${await res.text()}`)
        process.exit(1)
      }
      const list = (await res.json()) as Array<{
        code: string
        url: string
        host: string
        expires: number
        remaining: number
      }>

      UI.println("")
      if (list.length === 0) {
        UI.println(UI.Style.TEXT_DIM + "No active invites" + UI.Style.TEXT_NORMAL)
      } else {
        UI.println(UI.Style.TEXT_HIGHLIGHT + `${list.length} active invite(s):` + UI.Style.TEXT_NORMAL)
        UI.println("")
        for (const inv of list) {
          const mins = Math.round(inv.remaining / 60000)
          UI.println(`  ${inv.code}  ${UI.Style.TEXT_DIM}${inv.url}  (${mins}m left)${UI.Style.TEXT_NORMAL}`)
        }
      }
      UI.println("")
    } catch (e: any) {
      UI.error(`Failed to list invites: ${e.message}`)
      process.exit(1)
    }
  },
})

export const InviteCommand = cmd({
  command: "invite",
  describe: "workspace invite codes for remote collaboration",
  builder: (yargs: Argv) =>
    yargs
      .command(InviteCreateCommand)
      .command(InviteJoinCommand)
      .command(InviteRevokeCommand)
      .command(InviteListCommand)
      .demandCommand(),
  async handler() {},
})
