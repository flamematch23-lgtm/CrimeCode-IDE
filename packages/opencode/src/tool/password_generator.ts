import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Generate secure random passwords with customizable options"

const PARAMETERS = z.object({
  length: z.number().min(4).max(128).optional().describe("Password length (default: 16)"),
  includeUppercase: z.boolean().optional().describe("Include uppercase letters (default: true)"),
  includeLowercase: z.boolean().optional().describe("Include lowercase letters (default: true)"),
  includeNumbers: z.boolean().optional().describe("Include numbers (default: true)"),
  includeSymbols: z.boolean().optional().describe("Include symbols (default: true)"),
  excludeAmbiguous: z.boolean().optional().describe("Exclude ambiguous characters (0, O, l, 1, I) (default: false)"),
  count: z.number().min(1).max(100).optional().describe("Number of passwords to generate (default: 1)"),
})

export const PasswordGeneratorTool = Tool.define("password_generator", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      length: z.number().min(4).max(128).optional().describe("Password length (default: 16)"),
      includeUppercase: z.boolean().optional().describe("Include uppercase letters (default: true)"),
      includeLowercase: z.boolean().optional().describe("Include lowercase letters (default: true)"),
      includeNumbers: z.boolean().optional().describe("Include numbers (default: true)"),
      includeSymbols: z.boolean().optional().describe("Include symbols (default: true)"),
      excludeAmbiguous: z
        .boolean()
        .optional()
        .describe("Exclude ambiguous characters (0, O, l, 1, I) (default: false)"),
      count: z.number().min(1).max(100).optional().describe("Number of passwords to generate (default: 1)"),
    }),
    async execute(params) {
      const length = params.length || 16
      const count = params.count || 1

      let chars = ""
      if (params.includeLowercase !== false) chars += "abcdefghijklmnopqrstuvwxyz"
      if (params.includeUppercase !== false) chars += "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      if (params.includeNumbers !== false) chars += "0123456789"
      if (params.includeSymbols !== false) chars += "!@#$%^&*()_+-=[]{}|;:,.<>?"

      if (params.excludeAmbiguous) {
        chars = chars.replace(/[0OlI1|]/g, "")
      }

      if (chars.length === 0) {
        return {
          title: "Password Generator",
          output: "Error: At least one character set must be included",
          metadata: { action: "password_generator", result: "error" },
        }
      }

      const generate = () => {
        let password = ""
        const array = new Uint32Array(length)
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(array)
        } else {
          for (let i = 0; i < length; i++) {
            array[i] = Math.floor(Math.random() * 0xffffffff)
          }
        }
        for (let i = 0; i < length; i++) {
          password += chars[array[i] % chars.length]
        }
        return password
      }

      const passwords: string[] = []
      for (let i = 0; i < count; i++) {
        passwords.push(generate())
      }

      let output = `## Password Generator\n\n`
      output += `| Setting | Value |\n|------|-------|\n`
      output += `| Length | ${length} |\n`
      output += `| Uppercase | ${params.includeUppercase !== false ? "Yes" : "No"} |\n`
      output += `| Lowercase | ${params.includeLowercase !== false ? "Yes" : "No"} |\n`
      output += `| Numbers | ${params.includeNumbers !== false ? "Yes" : "No"} |\n`
      output += `| Symbols | ${params.includeSymbols !== false ? "Yes" : "No"} |\n`
      output += `| Exclude Ambiguous | ${params.excludeAmbiguous ? "Yes" : "No"} |\n\n`

      output += `### Generated Password${count > 1 ? "s" : ""}\n\n`
      for (const pw of passwords) {
        output += `\`\`\`\n${pw}\n\`\`\`\n\n`
      }

      output += `\n**Strength Estimate**: ${estimateStrength(passwords[0])}\n`

      return {
        title: "Password Generator",
        output,
        metadata: { action: "password_generator", result: "success" },
      }
    },
  }
})

function estimateStrength(password: string): string {
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (password.length >= 16) score++
  if (/[a-z]/.test(password)) score++
  if (/[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++

  if (score <= 2) return "Weak"
  if (score <= 4) return "Medium"
  if (score <= 6) return "Strong"
  return "Very Strong"
}
