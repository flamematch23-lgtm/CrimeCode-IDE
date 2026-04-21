import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Convert between different units of measurement"

const PARAMETERS = z.object({
  value: z.number().describe("Value to convert"),
  from: z.string().describe("Source unit (e.g., km, lb, celsius)"),
  to: z.string().describe("Target unit (e.g., mi, kg, fahrenheit)"),
})

const conversions: Record<string, Record<string, (v: number) => number>> = {
  length: {
    km_mi: (v) => v * 0.621371,
    mi_km: (v) => v * 1.60934,
    m_ft: (v) => v * 3.28084,
    ft_m: (v) => v / 3.28084,
    cm_in: (v) => v * 0.393701,
    in_cm: (v) => v / 0.393701,
    km_m: (v) => v * 1000,
    m_km: (v) => v / 1000,
  },
  weight: {
    kg_lb: (v) => v * 2.20462,
    lb_kg: (v) => v / 2.20462,
    g_oz: (v) => v * 0.035274,
    oz_g: (v) => v / 0.035274,
    kg_g: (v) => v * 1000,
    g_kg: (v) => v / 1000,
  },
  temperature: {
    celsius_fahrenheit: (v) => (v * 9) / 5 + 32,
    fahrenheit_celsius: (v) => ((v - 32) * 5) / 9,
    celsius_kelvin: (v) => v + 273.15,
    kelvin_celsius: (v) => v - 273.15,
  },
  volume: {
    l_gal: (v) => v * 0.264172,
    gal_l: (v) => v * 3.78541,
    ml_l: (v) => v / 1000,
    l_ml: (v) => v * 1000,
  },
  speed: {
    kmh_mph: (v) => v * 0.621371,
    mph_kmh: (v) => v * 1.60934,
    ms_kmh: (v) => v * 3.6,
    kmh_ms: (v) => v / 3.6,
  },
  data: {
    kb_mb: (v) => v / 1024,
    mb_kb: (v) => v * 1024,
    mb_gb: (v) => v / 1024,
    gb_mb: (v) => v * 1024,
    gb_tb: (v) => v / 1024,
    tb_gb: (v) => v * 1024,
  },
}

const unitAliases: Record<string, string> = {
  kilometers: "km",
  miles: "mi",
  meters: "m",
  feet: "ft",
  centimeters: "cm",
  inches: "in",
  kilograms: "kg",
  pounds: "lb",
  grams: "g",
  ounces: "oz",
  liters: "l",
  gallons: "gal",
  milliliters: "ml",
  celsius: "celsius",
  fahrenheit: "fahrenheit",
  kelvin: "kelvin",
}

export const UnitConverterTool = Tool.define("unit_converter", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const normalize = (u: string) => unitAliases[u.toLowerCase()] || u.toLowerCase()
    const from = normalize(params.from)
    const to = normalize(params.to)
    const key = `${from}_${to}`

    let converted: number | null = null
    let found = false

    for (const category of Object.values(conversions)) {
      if (category[key]) {
        converted = category[key](params.value)
        found = true
        break
      }
    }

    if (!found) {
      return {
        title: "Unit Converter",
        output: `Conversion from "${params.from}" to "${params.to}" not supported.\n\nSupported conversions:\n${Object.entries(
          conversions,
        )
          .map(([cat, convs]) => `**${cat}**: ${Object.keys(convs).join(", ")}`)
          .join("\n")}`,
        metadata: { action: "unit_converter", result: "not_found", from, to, converted },
      }
    }

    const formatted =
      converted !== null && (converted < 0.01 || converted > 10000)
        ? converted.toExponential(4)
        : (converted ?? 0).toFixed(4)

    return {
      title: "Unit Converter",
      output: `## Unit Converter\n\n**From**: ${params.value} ${params.from}
**To**: ${formatted} ${params.to}`,
      metadata: { action: "unit_converter", result: "success", from, to, converted },
    }
  },
})
