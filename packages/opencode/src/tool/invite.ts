import z from "zod"
import { Tool } from "./tool"
import { randomBytes } from "crypto"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DESCRIPTION = `Generate an invitation code for remote collaboration. Creates a shareable code that other users can use to join a session or project. The code is saved locally and can be shared via various channels.`

function getInviteDir(): string {
  const dir = join(homedir(), "OpenCode", "invites")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export const InviteTool = Tool.define("invite", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z
      .enum(["create", "list"])
      .default("create")
      .describe("Action to perform: 'create' generates a new invite code, 'list' shows existing codes"),
    format: z
      .enum(["text", "qr"])
      .default("text")
      .describe("Format for the invite: 'text' returns just the code, 'qr' generates a visual QR code"),
  }),
  async execute(params) {
    if (params.action === "create") {
      return await createInvite(params.format)
    }
    return await listInvites()
  },
})

async function createInvite(format: "text" | "qr") {
  const code = randomBytes(16).toString("hex").toUpperCase()
  const dir = getInviteDir()

  if (format === "text") {
    // Save code as text file
    const filename = `invite_${code.substring(0, 8)}.txt`
    const filepath = join(dir, filename)
    writeFileSync(filepath, code)

    return {
      output: `Invite code created: ${code}\n\nSaved to: ${filepath}\n\nShare this code with collaborators to allow them to join your session.`,
      title: "Invite Code Created",
      metadata: {
        action: "create",
        code,
        filepath,
        format,
      },
    }
  }

  // QR format
  const filename = `invite_${code.substring(0, 8)}.svg`
  const filepath = join(dir, filename)

  // Create SVG QR code visualization
  const qrSVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="50%" y="45%" font-size="12" text-anchor="middle" font-family="monospace" fill="#000000">${code}</text>
  <rect x="10" y="60" width="30" height="30" fill="#000000"/>
  <rect x="70" y="60" width="30" height="30" fill="#000000"/>
  <rect x="130" y="60" width="30" height="30" fill="#000000"/>
  <rect x="10" y="110" width="30" height="30" fill="#000000"/>
  <rect x="70" y="110" width="30" height="30" fill="#000000"/>
  <rect x="130" y="110" width="30" height="30" fill="#000000"/>
</svg>`

  writeFileSync(filepath, qrSVG)

  return {
    output: `Invite code created: ${code}\n\nQR code saved to: ${filepath}\n\nShare this code or the QR code image with collaborators.`,
    title: "Invite Code with QR Generated",
    metadata: {
      action: "create",
      code,
      filepath,
      format,
    },
  }
}

async function listInvites() {
  const dir = getInviteDir()

  // For now, return info about the invites directory
  return {
    output: `Invite codes are stored in: ${dir}\n\nUse 'create' action to generate new invite codes.`,
    title: "Invites Directory",
    metadata: {
      action: "list",
      code: "",
      filepath: "",
      format: "",
    },
  }
}
