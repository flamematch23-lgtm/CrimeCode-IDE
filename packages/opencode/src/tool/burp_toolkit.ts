/**
 * burp_toolkit — exposes the local Burp-Suite-style security toolkit to the
 * AI agent as a single, well-typed tool. The agent picks a sub-tool, passes
 * its CLI args, and (optionally) some stdin input. The wrapper resolves the
 * script path, runs it as a child process, and returns the captured output.
 *
 * The actual tools live in:
 *   packages/opencode/script/agent-tools/security/*.ts
 *
 * They each expose --json, so when `as_json: true` is set we hand back JSON
 * for the model to reason over. Without that flag we return the human-readable
 * text form.
 */
import z from "zod"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { Tool } from "./tool"
import DESCRIPTION from "./burp_toolkit.txt"

const SUBTOOLS = [
  "proxy",
  "repeater",
  "intruder",
  "decoder",
  "comparer",
  "sequencer",
  "scanner",
  "crawler",
  "param-miner",
] as const

const SCRIPT_BY_SUBTOOL: Record<(typeof SUBTOOLS)[number], string> = {
  proxy: "http-proxy.ts",
  repeater: "http-repeater.ts",
  intruder: "http-fuzzer.ts",
  decoder: "crypto-decoder.ts",
  comparer: "http-comparer.ts",
  sequencer: "token-sequencer.ts",
  scanner: "vuln-scanner.ts",
  crawler: "site-crawler.ts",
  "param-miner": "param-miner.ts",
}

// Tools that perform active probing — flagged so we can require explicit
// agent reasoning / user permission before invoking.
const ACTIVE_SUBTOOLS = new Set<(typeof SUBTOOLS)[number]>([
  "intruder",
  "scanner", // for "active" mode (passive is fine)
  "sequencer", // for "collect"/"live" — those send N requests
  "param-miner",
  "crawler",
])

function resolveScript(name: string): string {
  // Walk up from cwd looking for the security/ directory.
  // Falls back to a path relative to the running file.
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "packages", "opencode", "script", "agent-tools", "security", name)
    if (existsSync(candidate)) return candidate
    dir = join(dir, "..")
  }
  // dev fallback — sibling of src
  return join(__dirname, "..", "..", "script", "agent-tools", "security", name)
}

const Params = z.object({
  subtool: z.enum(SUBTOOLS).describe("Which sub-tool to invoke"),
  args: z.array(z.string()).default([]).describe("CLI args to pass to the sub-tool"),
  stdin: z.string().optional().describe("Optional stdin to pipe (for decoder, comparer, etc.)"),
  as_json: z.boolean().default(false).describe("Append --json so the output is structured"),
  cwd: z.string().optional().describe("Working directory for the child process (default: process.cwd())"),
  timeout_ms: z.number().int().positive().optional().describe("Hard timeout for the run (default 120000)"),
})

export const BurpToolkitTool = Tool.define("burp_toolkit", async () => ({
  description: DESCRIPTION,
  parameters: Params,
  async execute(params, ctx) {
    const { subtool, args, stdin, as_json, cwd, timeout_ms } = params
    const scriptName = SCRIPT_BY_SUBTOOL[subtool]
    const scriptPath = resolveScript(scriptName)

    if (!existsSync(scriptPath)) {
      return {
        title: `burp_toolkit/${subtool}: missing script`,
        metadata: { ok: false, scriptPath },
        output: `Could not find ${scriptName} at ${scriptPath}. Make sure you're running from the opencode-main repo root, or pass an explicit cwd.`,
      }
    }

    // Build the final argv. Append --json if asked and the args don't already include it.
    const fullArgs = [scriptPath, ...args]
    if (as_json && !fullArgs.includes("--json")) fullArgs.push("--json")

    // Active subtools: ask the user once per session for blanket permission.
    if (ACTIVE_SUBTOOLS.has(subtool)) {
      await ctx.ask({
        permission: "burp_toolkit_active",
        patterns: [`${subtool}:${args.slice(0, 4).join(" ")}`],
        always: ["*"],
        metadata: { subtool, args: args.slice(0, 8) },
      })
    }

    const startedAt = Date.now()
    const result = await runBun(scriptPath, args.concat(as_json && !args.includes("--json") ? ["--json"] : []), {
      stdin,
      cwd,
      timeoutMs: timeout_ms ?? 120_000,
      signal: ctx.abort,
    })
    const durationMs = Date.now() - startedAt

    const exitOk = result.code === 0
    let metadataPayload: Record<string, unknown> = {
      ok: exitOk,
      exitCode: result.code,
      subtool,
      durationMs,
    }
    let formatted = result.stdout
    if (as_json) {
      try {
        const parsed = JSON.parse(result.stdout)
        metadataPayload = { ...metadataPayload, parsed }
      } catch {
        // not JSON — leave as text
      }
    }
    if (!exitOk) {
      formatted += result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""
    } else if (result.stderr.trim().length > 0) {
      // sub-tools log progress to stderr — surface it as a footer
      formatted += `\n\n--- progress ---\n${result.stderr.trim()}`
    }

    return {
      title: `burp_toolkit / ${subtool} ${args.slice(0, 3).join(" ")}`.slice(0, 80),
      metadata: metadataPayload,
      output: formatted.length > 64_000 ? formatted.slice(0, 64_000) + "\n... [truncated]" : formatted,
    }
  },
}))

interface RunResult {
  code: number
  stdout: string
  stderr: string
  signal: NodeJS.Signals | null
}

async function runBun(
  scriptPath: string,
  args: string[],
  opts: { stdin?: string; cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [scriptPath, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const stop = setTimeout(() => {
      child.kill("SIGTERM")
    }, opts.timeoutMs)
    if (opts.signal) {
      const onAbort = () => child.kill("SIGTERM")
      opts.signal.addEventListener("abort", onAbort, { once: true })
      child.on("exit", () => opts.signal?.removeEventListener("abort", onAbort))
    }
    if (opts.stdin) {
      child.stdin.end(opts.stdin)
    } else {
      child.stdin.end()
    }
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")))
    child.on("close", (code, signal) => {
      clearTimeout(stop)
      resolve({ code: code ?? -1, stdout, stderr, signal })
    })
    child.on("error", (err) => {
      clearTimeout(stop)
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, signal: null })
    })
  })
}
