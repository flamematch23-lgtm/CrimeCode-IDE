import { Tool } from "./tool"
import z from "zod"
import { execSync } from "child_process"

const DESCRIPTION = "Convert text to speech using Windows built-in TTS engine"

const PARAMETERS = z.object({
  text: z.string().describe("Text to speak"),
  rate: z.number().optional().describe("Speech rate (-10 to 10, default: 0)"),
  volume: z.number().optional().describe("Volume (0 to 100, default: 100)"),
  voice: z.string().optional().describe("Voice name to use (optional)"),
  wait: z.boolean().optional().describe("Wait for speech to complete (default: true)"),
})

export const SpeakTool = Tool.define("speak", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const isWin = process.platform === "win32"
    const rate = params.rate ?? 0
    const volume = params.volume ?? 100

    if (!isWin) {
      return {
        title: "Text to Speech",
        output: "Text-to-speech is only available on Windows",
        metadata: { action: "speak", result: "unavailable", rate, volume },
      }
    }

    const voice = params.voice ? `-Voice "${params.voice}"` : ""
    const wait = params.wait !== false ? "" : "-Async"

    try {
      const escapedText = params.text.replace(/'/g, "''")
      const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${params.voice ? `$synth.SelectVoice('${params.voice}')` : ""}
$synth.Rate = ${rate}
$synth.Volume = ${volume}
$synth.Speak${wait ? ` '${escapedText}'` : ` Async('${escapedText}')`}${wait ? "\n$synth.Dispose()" : ""}
`
      execSync(`powershell -Command "${script}"`, { encoding: "utf-8", timeout: 30000 })

      return {
        title: "Text to Speech",
        output: `## Text to Speech\n\n**Status**: Speaking\n**Rate**: ${rate}\n**Volume**: ${volume}%\n**Text**: ${params.text.slice(0, 100)}${params.text.length > 100 ? "..." : ""}`,
        metadata: { action: "speak", result: "success", rate, volume },
      }
    } catch (err: any) {
      return {
        title: "Text to Speech",
        output: `Error: ${err.message}`,
        metadata: { action: "speak", result: "error", rate, volume },
      }
    }
  },
})
