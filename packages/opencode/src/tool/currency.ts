import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Convert amounts between different currencies"

const PARAMETERS = z.object({
  amount: z.number().describe("Amount to convert"),
  from: z.string().describe("Source currency code (e.g., USD, EUR, GBP)"),
  to: z.string().describe("Target currency code (e.g., USD, EUR, GBP)"),
})

export const CurrencyTool = Tool.define("currency", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    let rate: number | null = null
    let converted: number | null = null
    let result = "error"
    let output = ""

    try {
      const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${params.from.toUpperCase()}`)
      if (!response.ok) {
        output = `Failed to fetch exchange rates for ${params.from}`
      } else {
        const data = (await response.json()) as any
        rate = data.rates?.[params.to.toUpperCase()] ?? null

        if (!rate) {
          output = `Currency ${params.to} not found`
          result = "not_found"
        } else {
          converted = params.amount * rate
          result = "success"
          output = `## Currency Converter\n\n**From**: ${params.amount} ${params.from.toUpperCase()}
**To**: ${converted.toFixed(2)} ${params.to.toUpperCase()}
**Rate**: 1 ${params.from.toUpperCase()} = ${rate.toFixed(4)} ${params.to.toUpperCase()}
**Last Updated**: ${data.date || "Unknown"}`
        }
      }
    } catch (err: any) {
      output = `Error: ${err.message}`
    }

    return {
      title: "Currency Converter",
      output,
      metadata: { action: "currency", result, from: params.from, to: params.to, rate, converted },
    }
  },
})
