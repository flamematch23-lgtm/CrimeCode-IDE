// Claude Code provider — bridges to the Pro/Max subscription via the ACP
// adapter (`@zed-industries/claude-code-acp`).
//
// Why ACP instead of `claude --print`:
// 1. Latency — one shared subprocess for the whole session, no 1.5–3s
//    cold-start per prompt.
// 2. Tool-use — Claude's native tools (Read/Edit/Bash/Grep/Glob/Write/
//    Task/etc.) become first-class via JSON-RPC `tool_call` notifications
//    that map directly to AI SDK `tool-input-*` stream parts. CrimeCode
//    sees what Claude is doing and can show it in the chat UI.
// 3. Permissions — file IO and tool execution route through callbacks
//    (`requestPermission`, `readTextFile`, `writeTextFile`) so CrimeCode
//    stays in control of the user's filesystem.
//
// Why this still uses the Pro/Max subscription:
// The ACP adapter is just an adapter — it shells out to the user's
// installed `claude` CLI binary, which authenticates via the Pro/Max
// OAuth tokens that `claude auth login` set up. Cost per request = $0.

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk"
import { spawnSync } from "child_process"
import { Log } from "../../../util/log"
import { acquireSession, type AcpSessionHandle } from "./acp-client"

const log = Log.create({ service: "claude-code" })

// ────────────────────────────────────────────────────────────────────
// Detection helpers (sync — called at provider-init time, not per-request)
// ────────────────────────────────────────────────────────────────────

export interface ClaudeCliStatus {
  installed: boolean
  version?: string
  loggedIn?: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
  errorMessage?: string
  /** Absolute path to the binary that worked. Use this everywhere instead
   *  of `claude`, because the sidecar's PATH is often missing the user's
   *  install dir (e.g. ~/.local/bin) even though the user can run `claude`
   *  from their shell. */
  cliPath?: string
}

import { existsSync } from "node:fs"
import { join } from "node:path"

// Cache is now PERMANENT for the session once a working CLI is found.
// We only re-probe if the cached entry was a failure (so newly-installed
// CLIs are picked up without restart) or if the caller forces it.
let _cachedStatus: ClaudeCliStatus | null = null
let _cachedAt = 0
const CACHE_FAILURE_MS = 10_000 // re-probe failed detection after 10s

/** Build a list of candidate paths to try for the `claude` binary, in
 *  order of preference. Includes:
 *   1. CLAUDE_CODE_CLI env var override (full path)
 *   2. Bare `claude` (relies on PATH — fast path when it works)
 *   3. Common per-user install locations on each platform */
function candidatePaths(): string[] {
  const candidates: string[] = []
  const envOverride = process.env["CLAUDE_CODE_CLI"]
  if (envOverride) candidates.push(envOverride)
  candidates.push("claude")

  if (process.platform === "win32") {
    const home = process.env["USERPROFILE"] || process.env["HOME"]
    const localAppData = process.env["LOCALAPPDATA"]
    const appData = process.env["APPDATA"]
    if (home) {
      candidates.push(join(home, ".local", "bin", "claude.exe"))
      candidates.push(join(home, ".local", "bin", "claude.cmd"))
      candidates.push(join(home, ".local", "bin", "claude"))
    }
    if (localAppData) {
      candidates.push(join(localAppData, "Programs", "claude", "claude.exe"))
      candidates.push(join(localAppData, "claude", "claude.exe"))
    }
    if (appData) {
      candidates.push(join(appData, "npm", "claude.cmd"))
      candidates.push(join(appData, "npm", "claude.ps1"))
    }
  } else {
    const home = process.env["HOME"]
    if (home) candidates.push(join(home, ".local", "bin", "claude"))
    candidates.push("/usr/local/bin/claude")
    candidates.push("/opt/homebrew/bin/claude")
    candidates.push("/usr/bin/claude")
  }
  return candidates
}

/** Try one candidate by spawning `<path> --version`. Returns the version
 *  string on success, or null on failure. */
function probeVersion(path: string): string | null {
  try {
    // Bare names (no separator) need shell on Windows so .cmd/.ps1 wrappers
    // resolve via PATHEXT. Absolute paths can run without a shell.
    const isBareName = !path.includes("/") && !path.includes("\\")
    const useShell = process.platform === "win32" && isBareName
    // For absolute paths to .cmd / .ps1 / .bat, we still need shell on win32.
    const useShellForExt =
      process.platform === "win32" &&
      (path.endsWith(".cmd") || path.endsWith(".ps1") || path.endsWith(".bat"))
    const result = spawnSync(path, ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      shell: useShell || useShellForExt,
    })
    if (result.status === 0) return (result.stdout || "").trim()
    return null
  } catch {
    return null
  }
}

export function detectClaudeCli(force = false): ClaudeCliStatus {
  // If we already have a successful detection, REUSE it forever (the user
  // doesn't uninstall the CLI mid-session). Failure cache has short TTL so
  // newly-installed CLIs are picked up on the next call.
  if (!force && _cachedStatus) {
    if (_cachedStatus.installed) return _cachedStatus
    if (Date.now() - _cachedAt < CACHE_FAILURE_MS) return _cachedStatus
  }

  const status: ClaudeCliStatus = { installed: false }
  const tried: string[] = []

  // 1. Find a working binary.
  for (const candidate of candidatePaths()) {
    // Skip non-existent absolute paths fast (avoids slow ENOENT spawns).
    if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) {
      continue
    }
    tried.push(candidate)
    const version = probeVersion(candidate)
    if (version !== null) {
      status.installed = true
      status.version = version
      status.cliPath = candidate
      log.info("found CLI", { path: candidate, version })
      break
    }
  }
  if (!status.installed) {
    status.errorMessage = `claude CLI not found. Tried: ${tried.join(", ")}`
  }

  // 2. Auth status (only if installed).
  if (status.installed && status.cliPath) {
    try {
      const isAbsoluteExt =
        status.cliPath.endsWith(".cmd") ||
        status.cliPath.endsWith(".ps1") ||
        status.cliPath.endsWith(".bat")
      const useShell =
        process.platform === "win32" &&
        ((!status.cliPath.includes("/") && !status.cliPath.includes("\\")) || isAbsoluteExt)
      const authResult = spawnSync(status.cliPath, ["auth", "status"], {
        encoding: "utf-8",
        timeout: 5_000,
        shell: useShell,
        // Pass HOME/USERPROFILE explicitly because some Electron sidecar
        // environments lose them, and `claude` reads its credentials from
        // ~/.claude (which it builds from HOME). Without this the binary
        // sees "no auth" even though the user is logged in via shell.
        env: {
          ...process.env,
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
          USERPROFILE: process.env.USERPROFILE ?? process.env.HOME ?? "",
        },
      })
      if (authResult.status === 0) {
        try {
          const parsed = JSON.parse(authResult.stdout || "{}")
          status.loggedIn = !!parsed.loggedIn
          status.authMethod = parsed.authMethod
          status.email = parsed.email
          status.subscriptionType = parsed.subscriptionType
          if (!status.loggedIn) {
            // Surface raw stdout for diagnostic — sometimes the binary returns
            // {"loggedIn": false} with no other detail and the user can't tell
            // whether it's a real logout or a credential-store access failure.
            const snippet = (authResult.stdout || "").slice(0, 200).replace(/\s+/g, " ")
            status.errorMessage = `claude auth status: not logged in (raw: ${snippet})`
          }
        } catch (parseErr) {
          status.loggedIn = false
          const snippet = (authResult.stdout || "").slice(0, 200).replace(/\s+/g, " ")
          status.errorMessage = `claude auth status returned non-JSON output: "${snippet}" (parse: ${String(parseErr).slice(0, 60)})`
        }
      } else {
        status.loggedIn = false
        const stderr = (authResult.stderr || "").slice(0, 200).replace(/\s+/g, " ")
        const stdout = (authResult.stdout || "").slice(0, 100).replace(/\s+/g, " ")
        status.errorMessage =
          `claude auth status exited ${authResult.status}` +
          (stderr ? ` — stderr: ${stderr}` : "") +
          (stdout ? ` — stdout: ${stdout}` : "") +
          ` (HOME=${process.env.HOME ?? "(unset)"}, USERPROFILE=${process.env.USERPROFILE ?? "(unset)"})`
      }
    } catch (e: any) {
      status.loggedIn = false
      status.errorMessage = `claude auth status failed: ${e?.code || e?.message || "unknown"}`
    }
  }

  _cachedStatus = status
  _cachedAt = Date.now()
  log.info("detected", {
    installed: status.installed,
    loggedIn: status.loggedIn,
    subscriptionType: status.subscriptionType,
    version: status.version,
    cliPath: status.cliPath,
  })
  return status
}

// ────────────────────────────────────────────────────────────────────
// LanguageModelV2 implementation (ACP-backed)
// ────────────────────────────────────────────────────────────────────

export interface ClaudeCodeModelOptions {
  /** Working directory for the spawned ACP adapter. Defaults to cwd. */
  cwd?: string
  /** Absolute path to the `claude` CLI binary. When provided, its parent
   *  directory is prepended to the ACP adapter's PATH so the adapter can
   *  shell out to `claude` even when our process PATH lacks the install
   *  dir (the common case in Electron sidecar). */
  claudeCliPath?: string
}

export class ClaudeCodeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = "claude-code"
  readonly modelId: string
  readonly supportedUrls = {}

  private readonly opts: ClaudeCodeModelOptions

  constructor(modelId: string, opts: ClaudeCodeModelOptions = {}) {
    this.modelId = modelId
    this.opts = opts
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const blocks = mapPromptToBlocks(options.prompt)
    const session = await acquireSession({
      cwd: this.opts.cwd,
      claudeCliPath: this.opts.claudeCliPath,
    })

    let assembledText = ""
    let finishReason: LanguageModelV2FinishReason = "unknown"
    const warnings: any[] = []

    try {
      const res = await session.prompt(blocks, (n) => {
        const u: any = n.update
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          assembledText += u.content.text ?? ""
        }
      })
      finishReason = mapStopReason(res.stopReason)
      const usage = mapUsage(res.usage)

      const content: LanguageModelV2Content[] = []
      if (assembledText) content.push({ type: "text", text: assembledText })

      return {
        content,
        finishReason,
        usage,
        providerMetadata: {
          "claude-code": { sessionId: session.sessionId, transport: "acp" },
        },
        warnings,
        response: { timestamp: new Date() },
      }
    } finally {
      await session.close().catch(() => {})
    }
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const blocks = mapPromptToBlocks(options.prompt)
    const session = await acquireSession({
      cwd: this.opts.cwd,
      claudeCliPath: this.opts.claudeCliPath,
    })

    // Build the AI SDK stream that mirrors ACP session/update events.
    let textBlockId: string | null = null
    const toolBlocks = new Map<string, { id: string; name: string }>()
    let finalUsage: LanguageModelV2Usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }
    let finishReason: LanguageModelV2FinishReason = "unknown"
    let cancelled = false

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })

        const startText = () => {
          if (!textBlockId) {
            textBlockId = `text-${Date.now()}`
            controller.enqueue({ type: "text-start", id: textBlockId })
          }
        }

        const handle = (n: SessionNotification) => {
          if (cancelled) return
          const u: any = n.update
          try {
            switch (u.sessionUpdate) {
              case "agent_message_chunk": {
                if (u.content?.type === "text" && typeof u.content.text === "string") {
                  startText()
                  controller.enqueue({
                    type: "text-delta",
                    id: textBlockId!,
                    delta: u.content.text,
                  })
                } else if (u.content?.type === "image") {
                  // Image deltas in assistant messages — translate to file part
                  controller.enqueue({
                    type: "file",
                    mediaType: u.content.mimeType ?? "image/png",
                    data: u.content.data ?? "",
                  } as any)
                }
                break
              }
              case "agent_thought_chunk": {
                if (u.content?.type === "text" && typeof u.content.text === "string") {
                  // AI SDK reasoning channel
                  if (!toolBlocks.has("__reasoning")) {
                    const id = "reasoning-" + Date.now()
                    toolBlocks.set("__reasoning", { id, name: "" })
                    controller.enqueue({ type: "reasoning-start", id })
                  }
                  const id = toolBlocks.get("__reasoning")!.id
                  controller.enqueue({ type: "reasoning-delta", id, delta: u.content.text })
                }
                break
              }
              case "tool_call": {
                // Close any open text block before announcing a tool call.
                if (textBlockId) {
                  controller.enqueue({ type: "text-end", id: textBlockId })
                  textBlockId = null
                }
                const toolCallId = String(u.toolCallId ?? `tc-${Date.now()}`)
                const name = String(u.title ?? u.kind ?? "tool")
                toolBlocks.set(toolCallId, { id: toolCallId, name })
                controller.enqueue({
                  type: "tool-input-start",
                  id: toolCallId,
                  toolName: name,
                })
                if (u.rawInput) {
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: toolCallId,
                    delta: typeof u.rawInput === "string" ? u.rawInput : JSON.stringify(u.rawInput),
                  })
                }
                controller.enqueue({ type: "tool-input-end", id: toolCallId })
                controller.enqueue({
                  type: "tool-call",
                  toolCallId,
                  toolName: name,
                  input: u.rawInput ?? {},
                  providerExecuted: true,
                })
                break
              }
              case "tool_call_update": {
                // Update existing tool call (e.g. status: in_progress → completed).
                // When the agent finishes a tool, surface the result so
                // the AI SDK consumer can show it in the chat UI.
                if (u.status === "completed" && u.toolCallId && u.content) {
                  controller.enqueue({
                    type: "tool-result",
                    toolCallId: String(u.toolCallId),
                    toolName: toolBlocks.get(String(u.toolCallId))?.name ?? "tool",
                    result: u.content,
                    providerExecuted: true,
                  } as any)
                }
                break
              }
              case "plan":
              case "available_commands_update":
              case "current_mode_update":
                // Informational; don't surface to AI SDK consumer.
                break
              default:
                // Unknown update — swallow silently to avoid breaking on
                // future ACP additions.
                log.info("unhandled session update", { kind: u.sessionUpdate })
            }
          } catch (e) {
            log.warn("stream handler error", { err: String(e) })
          }
        }

        // Cancel via the AI SDK abort signal.
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            cancelled = true
            void session.cancel()
          }, { once: true })
        }

        // Fire the prompt; on completion close the stream with a finish part.
        session.prompt(blocks, handle).then(
          (res) => {
            finishReason = mapStopReason(res.stopReason)
            finalUsage = mapUsage(res.usage)
            try {
              if (textBlockId) {
                controller.enqueue({ type: "text-end", id: textBlockId })
                textBlockId = null
              }
              const reasoningBlock = toolBlocks.get("__reasoning")
              if (reasoningBlock) {
                controller.enqueue({ type: "reasoning-end", id: reasoningBlock.id })
              }
              controller.enqueue({
                type: "finish",
                usage: finalUsage,
                finishReason,
                providerMetadata: {
                  "claude-code": { sessionId: session.sessionId, transport: "acp" },
                },
              })
              controller.close()
            } catch {}
            void session.close()
          },
          (err) => {
            try {
              controller.enqueue({ type: "error", error: err })
              controller.close()
            } catch {}
            void session.close()
          },
        )
      },
      cancel() {
        cancelled = true
        void session.cancel()
        void session.close()
      },
    })

    return { stream }
  }
}

// ────────────────────────────────────────────────────────────────────
// Prompt mapping: AI SDK V2 prompt → ACP ContentBlock array
// ────────────────────────────────────────────────────────────────────

function mapPromptToBlocks(prompt: LanguageModelV2Prompt): ContentBlock[] {
  // ACP's prompt input is a flat array of content blocks (text / image /
  // resource_link / resource), not a structured chat. We collapse the AI
  // SDK message history into a transcript prefix + the latest user turn,
  // because each ACP session here is fresh (we don't reuse session IDs
  // across calls — see acquireSession docstring).
  const transcript: string[] = []
  const systemParts: string[] = []
  let lastUser: string = ""

  for (const msg of prompt) {
    if (msg.role === "system") {
      systemParts.push(msg.content)
      continue
    }
    if (msg.role === "user") {
      const text = msg.content
        .map((p) => {
          if (p.type === "text") return p.text
          if (p.type === "file") return `[file: ${p.filename ?? "(unnamed)"} ${p.mediaType}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
      transcript.push(`<user>\n${text}\n</user>`)
      lastUser = text
      continue
    }
    if (msg.role === "assistant") {
      const text = msg.content
        .map((p) => {
          if (p.type === "text") return p.text
          if (p.type === "reasoning") return `<thinking>${p.text}</thinking>`
          if (p.type === "tool-call") return `[tool call: ${p.toolName}]`
          if (p.type === "tool-result") return `[tool result: ${p.toolName}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text) transcript.push(`<assistant>\n${text}\n</assistant>`)
      continue
    }
    if (msg.role === "tool") {
      const text = msg.content
        .map((p) => {
          const out = p.output
          if (out.type === "text" || out.type === "error-text") return out.value
          if (out.type === "json" || out.type === "error-json") return JSON.stringify(out.value)
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text) transcript.push(`<tool-result>\n${text}\n</tool-result>`)
      continue
    }
  }

  const blocks: ContentBlock[] = []

  // System prompt (if any) goes as the first text block. ACP doesn't
  // distinguish system from user at the block level — the agent's
  // session has its own internal system prompt; this is just extra
  // context the user provides.
  if (systemParts.length) {
    blocks.push({
      type: "text",
      text: `[System instructions]\n${systemParts.join("\n\n")}`,
    })
  }

  // If we have prior turns, send transcript context first, then the
  // last user message as a separate block (so the agent treats it as
  // the active question rather than part of the history).
  if (transcript.length > 1) {
    blocks.push({
      type: "text",
      text: `Conversation history:\n\n${transcript.slice(0, -1).join("\n\n")}`,
    })
    blocks.push({ type: "text", text: lastUser || transcript[transcript.length - 1]! })
  } else {
    blocks.push({ type: "text", text: lastUser || transcript.join("\n\n") })
  }

  return blocks
}

// ────────────────────────────────────────────────────────────────────
// Mapping helpers
// ────────────────────────────────────────────────────────────────────

function mapUsage(u?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }): LanguageModelV2Usage {
  if (!u) return { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }
  const total =
    u.inputTokens !== undefined && u.outputTokens !== undefined
      ? u.inputTokens + u.outputTokens + (u.cachedInputTokens ?? 0)
      : undefined
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: total,
    cachedInputTokens: u.cachedInputTokens,
  }
}

function mapStopReason(reason: string): LanguageModelV2FinishReason {
  switch (reason) {
    case "end_turn":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool-calls"
    case "stop_sequence":
      return "stop"
    case "refusal":
      return "content-filter"
    case "cancelled":
      return "other"
    default:
      return "unknown"
  }
}
