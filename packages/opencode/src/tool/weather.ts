import { Tool } from "./tool"
import z from "zod"

const DESCRIPTION = "Get current weather information for a location"

const PARAMETERS = z.object({
  location: z.string().describe("City name or location"),
  units: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature units (default: celsius)"),
})

export const WeatherTool = Tool.define("weather", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    try {
      const units = params.units === "fahrenheit" ? "imperial" : "metric"
      const url = `https://wttr.in/${encodeURIComponent(params.location)}?format=j1&u=${units}`

      const response = await fetch(url)
      if (!response.ok) {
        return {
          title: "Weather",
          output: `Failed to fetch weather data for "${params.location}"`,
          metadata: { action: "weather", result: "error", location: params.location, temp: null, unit: "" },
        }
      }

      const data = (await response.json()) as any
      const current = data.current_condition?.[0]

      if (!current) {
        return {
          title: "Weather",
          output: `No weather data found for "${params.location}"`,
          metadata: { action: "weather", result: "not_found", location: params.location, temp: null, unit: "" },
        }
      }

      const temp = current.temp_C || current.temp_F
      const unit = params.units === "fahrenheit" ? "F" : "C"
      const feelsLike = units === "imperial" ? current.FeelsLikeF : current.FeelsLikeC
      const humidity = current.humidity
      const wind = units === "imperial" ? current.windspeedMiles : current.windspeedKmph
      const windUnit = units === "imperial" ? "mph" : "km/h"
      const desc = current.weatherDesc?.[0]?.value || "Unknown"
      const location = data.nearest_area?.[0]?.areaName?.[0]?.value || params.location

      const output = `## Weather: ${location}\n\n**Condition**: ${desc}
**Temperature**: ${temp}°${unit}
**Feels Like**: ${feelsLike}°${unit}
**Humidity**: ${humidity}%
**Wind**: ${wind} ${windUnit}
**UV Index**: ${current.uvIndex || "N/A"}
**Visibility**: ${current.visibility || "N/A"} km
**Pressure**: ${current.pressure || "N/A"} mb

_${data.closest_date || ""}_`

      return {
        title: `Weather: ${location}`,
        output,
        metadata: { action: "weather", location, result: "success", temp, unit },
      }
    } catch (err: any) {
      return {
        title: "Weather",
        output: `Error fetching weather: ${err.message}`,
        metadata: { action: "weather", result: "error", location: params.location, temp: null, unit: "" },
      }
    }
  },
})
