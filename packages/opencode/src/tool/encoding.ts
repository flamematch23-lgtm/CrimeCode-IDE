import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Encode or decode data in various formats (Base64, URL, HTML, Hex, Binary)"

const PARAMETERS = z.object({
  action: z.enum(["encode", "decode"]).describe("Encode or decode the input"),
  format: z.enum(["base64", "url", "html", "hex", "binary", "rot13"]).describe("Encoding format"),
  input: z.string().describe("The string to encode/decode"),
})

export const EncodingTool = Tool.define("encoding", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["encode", "decode"]).describe("Encode or decode the input"),
      format: z.enum(["base64", "url", "html", "hex", "binary", "rot13"]).describe("Encoding format"),
      input: z.string().describe("The string to encode/decode"),
    }),
    async execute(params) {
      let result = ""
      let error = ""

      try {
        switch (params.format) {
          case "base64":
            if (params.action === "encode") {
              result = Buffer.from(params.input, "utf8").toString("base64")
            } else {
              result = Buffer.from(params.input, "base64").toString("utf8")
            }
            break

          case "url":
            if (params.action === "encode") {
              result = encodeURIComponent(params.input)
            } else {
              result = decodeURIComponent(params.input)
            }
            break

          case "html":
            if (params.action === "encode") {
              result = params.input
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#x27;")
            } else {
              result = params.input
                .replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#x27;/g, "'")
            }
            break

          case "hex":
            if (params.action === "encode") {
              result = Buffer.from(params.input, "utf8").toString("hex")
            } else {
              result = Buffer.from(params.input, "hex").toString("utf8")
            }
            break

          case "binary":
            if (params.action === "encode") {
              result = params.input
                .split("")
                .map((c) => c.charCodeAt(0).toString(2).padStart(8, "0"))
                .join(" ")
            } else {
              result = params.input
                .split(" ")
                .map((b) => String.fromCharCode(parseInt(b, 2)))
                .join("")
            }
            break

          case "rot13":
            if (params.action === "encode") {
              result = params.input.replace(/[a-zA-Z]/g, (c) => {
                const base = c <= "Z" ? 65 : 97
                return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
              })
            } else {
              result = params.input.replace(/[a-zA-Z]/g, (c) => {
                const base = c <= "Z" ? 65 : 97
                return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
              })
            }
            break
        }
      } catch (err: any) {
        error = err.message
      }

      return {
        title: "Encoding/Decoding",
        output: error
          ? `Error: ${error}`
          : `## ${params.action === "encode" ? "Encoded" : "Decoded"} (${params.format.toUpperCase()})\n\n**Input**:\n\`\`\`\n${params.input}\n\`\`\`\n\n**Output**:\n\`\`\`\n${result}\n\`\`\``,
        metadata: { action: "encoding", format: params.format, result: error ? "error" : "success" },
      }
    },
  }
})
