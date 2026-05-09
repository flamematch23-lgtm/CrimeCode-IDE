// Claude Code CLI provider — uses the locally-installed `claude` binary
// (Claude Code CLI) as a bridge to the user's Pro/Max subscription.
//
// Why this exists:
// Anthropic OAuth tokens (Pro/Max) issued by `claude auth login` cannot be
// used directly against `api.anthropic.com/v1/messages` — Anthropic rejects
// them with "needs API key console" because they are scoped to the
// Claude Code CLI surface, not the public Messages API. Bridging via the
// installed CLI uses the subscription quota transparently, so a Pro/Max
// user pays $0 in API spend instead of being forced onto pay-per-token.
//
// Output format reverse-engineered from real CLI output (claude 2.1.x):
//   {"type":"system","subtype":"init",...}
//   {"type":"system","subtype":"hook_started",...}    // optional
//   {"type":"system","subtype":"hook_response",...}   // optional
//   {"type":"assistant","message":{"id":"msg_...","content":[{"type":"text","text":"..."}],"usage":{...}}}
//   {"type":"rate_limit_event","rate_limit_info":{...}}
//   {"type":"result","subtype":"success","result":"...","stop_reason":"end_turn","usage":{...},"total_cost_usd":...}
//
// Streaming uses --include-partial-messages which adds:
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process"
import { Log } from "../../../util/log"

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
}

let _cachedStatus: ClaudeCliStatus | null = null
let _cachedAt = 0
const CACHE_MS = 30_000

/**
 * Detect whether the Claude Code CLI is installed and the user is logged in.
 * Result is cached for 30 s to avoid spawning a subprocess on every list().
 */
export function detectClaudeCli(force = false): ClaudeCliStatus {
  if (!force && _cachedStatus && Date.now() - _cachedAt < CACHE_MS) return _cachedStatus

  const status: ClaudeCliStatus = { installed: false }

  // 1. claude --version
  try {
    const versionResult = spawnSync(getClaudeCommand(), ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      shell: process.platform === "win32",
    })
    if (versionResult.status === 0) {
      status.installed = true
      status.version = (versionResult.stdout || "").trim()
    } else {
      status.errorMessage = `claude --version exited ${versionResult.status}: ${versionResult.stderr || versionResult.stdout || "no output"}`
    }
  } catch (e: any) {
    status.errorMessage = `claude CLI not found in PATH (${e?.code || e?.message || "unknown error"})`
  }

  // 2. claude auth status (only if installed)
  if (status.installed) {
    try {
      const authResult = spawnSync(getClaudeCommand(), ["auth", "status"], {
        encoding: "utf-8",
        timeout: 5_000,
        shell: process.platform === "win32",
      })
      if (authResult.status === 0) {
        try {
          const parsed = JSON.parse(authResult.stdout || "{}")
          status.loggedIn = !!parsed.loggedIn
          status.authMethod = parsed.authMethod
          status.email = parsed.email
          status.subscriptionType = parsed.subscriptionType
        } catch {
          status.loggedIn = false
          status.errorMessage = "claude auth status returned non-JSON output"
        }
      } else {
        status.loggedIn = false
        status.errorMessage = `claude auth status exited ${authResult.status}`
      }
    } catch (e: any) {
      status.loggedIn = false
      status.errorMessage = `claude auth status failed (${e?.code || e?.message || "unknown error"})`
    }
  }

  _cachedStatus = status
  _cachedAt = Date.now()
  log.info("detected", {
    installed: status.installed,
    loggedIn: status.loggedIn,
    subscriptionType: status.subscriptionType,
    version: status.version,
  })
  return status
}

function getClaudeCommand(): string {
  // Allow override for testing or non-PATH installs
  return process.env["CLAUDE_CODE_CLI"] || "claude"
}

// ────────────────────────────────────────────────────────────────────
// LanguageModelV2 implementation
// ────────────────────────────────────────────────────────────────────

export interface ClaudeCodeModelOptions {
  /** Optional working directory for the spawned CLI. Defaults to process.cwd(). */
  cwd?: string
  /** Optional extra CLI args (rare — for power-user overrides via opencode.json). */
  extraArgs?: string[]
  /** Override CLI binary path (else $CLAUDE_CODE_CLI then "claude"). */
  cliPath?: string
}

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  message?: {
    id?: string
    model?: string
    role?: string
    content?: Array<{ type: string; text?: string }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  result?: string
  stop_reason?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  // Partial-message streaming events
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
  }
  rate_limit_info?: {
    status?: string
    rateLimitType?: string
    overageStatus?: string
  }
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

  // ──────────────────────────────────────────────────────────
  // doGenerate (non-streaming)
  // ──────────────────────────────────────────────────────────
  async doGenerate(options: LanguageModelV2CallOptions) {
    const { systemPrompt, userInputs } = mapPromptToCliInputs(options.prompt)
    const args = buildCliArgs(this.modelId, this.opts, systemPrompt, false)

    log.info("doGenerate spawn", { model: this.modelId, args: args.length })
    const result = await runClaudeCli(args, userInputs, this.opts, options.abortSignal)

    const content: LanguageModelV2Content[] = []
    if (result.text) content.push({ type: "text", text: result.text })

    return {
      content,
      finishReason: result.finishReason,
      usage: result.usage,
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          totalCostUsd: result.totalCostUsd ?? 0,
          durationMs: result.durationMs ?? 0,
        },
      },
      warnings: result.warnings,
      response: {
        id: result.responseId ?? undefined,
        modelId: result.responseModelId ?? undefined,
        timestamp: new Date(),
      },
    }
  }

  // ──────────────────────────────────────────────────────────
  // doStream (streaming)
  // ──────────────────────────────────────────────────────────
  async doStream(options: LanguageModelV2CallOptions) {
    const { systemPrompt, userInputs } = mapPromptToCliInputs(options.prompt)
    const args = buildCliArgs(this.modelId, this.opts, systemPrompt, true)

    log.info("doStream spawn", { model: this.modelId, args: args.length })

    const child = spawnClaude(args, this.opts, options.abortSignal)
    feedStdin(child, userInputs)

    const stream = makeStreamFromChild(child, options.abortSignal)
    return { stream }
  }
}

// ────────────────────────────────────────────────────────────────────
// Prompt → CLI input mapping
// ────────────────────────────────────────────────────────────────────

interface UserInputEvent {
  type: "user"
  message: { role: "user"; content: string }
}

function mapPromptToCliInputs(prompt: LanguageModelV2Prompt): {
  systemPrompt: string | undefined
  userInputs: UserInputEvent[]
} {
  // System messages are merged and passed via --system-prompt.
  // User + assistant messages are concatenated into a single text turn — the
  // CLI is invoked fresh per request so it has no prior history. We embed
  // role markers so the model sees the conversation transcript.
  //
  // (We could push each turn as a separate `user` event, but the CLI starts
  // a brand-new session each invocation, so multi-turn history is all the
  // caller's responsibility anyway. Single concatenated turn = same result,
  // simpler I/O.)
  const systemParts: string[] = []
  const transcriptParts: string[] = []
  let lastUserText = ""

  for (const msg of prompt) {
    if (msg.role === "system") {
      systemParts.push(msg.content)
      continue
    }
    if (msg.role === "user") {
      const text = msg.content
        .map((p) => {
          if (p.type === "text") return p.text
          if (p.type === "file") return `[attached file: ${p.filename || "(unnamed)"} ${p.mediaType}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
      transcriptParts.push(`<user>\n${text}\n</user>`)
      lastUserText = text
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
      if (text) transcriptParts.push(`<assistant>\n${text}\n</assistant>`)
      continue
    }
    if (msg.role === "tool") {
      // Tool results from previous turn — fold them into transcript context.
      const text = msg.content
        .map((p) => {
          const out = p.output
          if (out.type === "text" || out.type === "error-text") return out.value
          if (out.type === "json" || out.type === "error-json") return JSON.stringify(out.value)
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text) transcriptParts.push(`<tool-result>\n${text}\n</tool-result>`)
      continue
    }
  }

  const userInputText =
    transcriptParts.length > 1
      ? `Conversation so far:\n\n${transcriptParts.slice(0, -1).join("\n\n")}\n\nLatest message:\n${lastUserText}`
      : lastUserText || transcriptParts.join("\n\n")

  const userInputs: UserInputEvent[] = [
    {
      type: "user",
      message: { role: "user", content: userInputText },
    },
  ]

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    userInputs,
  }
}

// ────────────────────────────────────────────────────────────────────
// Spawn helpers
// ────────────────────────────────────────────────────────────────────

function buildCliArgs(
  modelId: string,
  opts: ClaudeCodeModelOptions,
  systemPrompt: string | undefined,
  withPartials: boolean,
): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--model",
    modelId,
    "--no-session-persistence",
    // Disable user's local skills/tools so we don't get bash/edit answers
    // for what should be a plain LLM call. (Skills also pull in the
    // user's plugin/superpowers prompt soup that we don't want here.)
    "--disable-slash-commands",
    // commander treats `--tools ""` as missing the value; the equals form
    // `--tools=` is parsed as the empty-string value the CLI documents.
    "--tools=",
  ]
  if (withPartials) args.push("--include-partial-messages")
  if (systemPrompt) args.push("--system-prompt", systemPrompt)
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  return args
}

function spawnClaude(
  args: string[],
  opts: ClaudeCodeModelOptions,
  abortSignal: AbortSignal | undefined,
): ChildProcessWithoutNullStreams {
  const cmd = opts.cliPath || getClaudeCommand()
  const child = spawn(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams

  if (abortSignal) {
    const onAbort = () => {
      try {
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
        }, 1500)
      } catch {}
    }
    abortSignal.addEventListener("abort", onAbort, { once: true })
  }

  return child
}

function feedStdin(child: ChildProcessWithoutNullStreams, userInputs: UserInputEvent[]) {
  try {
    for (const ev of userInputs) {
      child.stdin.write(JSON.stringify(ev) + "\n")
    }
    child.stdin.end()
  } catch (e) {
    log.warn("stdin write failed", { err: String(e) })
  }
}

// ────────────────────────────────────────────────────────────────────
// Non-streaming runner: collects full output, returns assembled text + usage
// ────────────────────────────────────────────────────────────────────

interface RunResult {
  text: string
  finishReason: LanguageModelV2FinishReason
  usage: LanguageModelV2Usage
  warnings: any[]
  sessionId?: string
  totalCostUsd?: number
  durationMs?: number
  responseId?: string
  responseModelId?: string
}

async function runClaudeCli(
  args: string[],
  userInputs: UserInputEvent[],
  opts: ClaudeCodeModelOptions,
  abortSignal: AbortSignal | undefined,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnClaude(args, opts, abortSignal)
    feedStdin(child, userInputs)

    let buffer = ""
    let stderrBuf = ""
    const events: ClaudeStreamEvent[] = []
    let assistantText = ""
    let usage: LanguageModelV2Usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }
    let finishReason: LanguageModelV2FinishReason = "unknown"
    let sessionId: string | undefined
    let totalCostUsd: number | undefined
    let durationMs: number | undefined
    let responseId: string | undefined
    let responseModelId: string | undefined
    const warnings: any[] = []

    child.stdout.setEncoding("utf-8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let idx
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line) as ClaudeStreamEvent
          events.push(ev)
          if (ev.type === "system" && ev.subtype === "init") {
            sessionId = (ev as any).session_id
          }
          if (ev.type === "assistant" && ev.message) {
            responseId = ev.message.id
            responseModelId = ev.message.model
            for (const block of ev.message.content || []) {
              if (block.type === "text" && block.text) assistantText += block.text
            }
            if (ev.message.usage) {
              usage = mapUsage(ev.message.usage, usage)
            }
          }
          if (ev.type === "result") {
            if (typeof ev.result === "string" && !assistantText) assistantText = ev.result
            finishReason = mapStopReason(ev.stop_reason)
            totalCostUsd = ev.total_cost_usd
            durationMs = ev.duration_ms
            if (ev.usage) usage = mapUsage(ev.usage, usage)
            if (ev.is_error) {
              warnings.push({ type: "other", message: "claude CLI returned is_error=true" })
            }
          }
        } catch (e) {
          // Non-JSON line — ignore (could be partial buffering during high throughput)
          log.warn("non-json stdout line", { line: line.slice(0, 120) })
        }
      }
    })

    child.stderr.setEncoding("utf-8")
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000)
    })

    child.on("error", (err) => reject(err))
    child.on("close", (code) => {
      if (code !== 0 && !assistantText) {
        const detail = stderrBuf.trim() || `claude CLI exited with code ${code}`
        return reject(new Error(`Claude CLI failed: ${detail}`))
      }
      resolve({
        text: assistantText,
        finishReason,
        usage,
        warnings,
        sessionId,
        totalCostUsd,
        durationMs,
        responseId,
        responseModelId,
      })
    })
  })
}

// ────────────────────────────────────────────────────────────────────
// Streaming runner: yield AI SDK stream parts as the CLI emits events
// ────────────────────────────────────────────────────────────────────

function makeStreamFromChild(
  child: ChildProcessWithoutNullStreams,
  abortSignal: AbortSignal | undefined,
): ReadableStream<LanguageModelV2StreamPart> {
  let buffer = ""
  let stderrBuf = ""
  let textBlockId: string | null = null
  let finalText = ""
  let usage: LanguageModelV2Usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }
  let finishReason: LanguageModelV2FinishReason = "unknown"
  let modelId: string | undefined
  let messageId: string | undefined
  let sessionId: string | undefined
  let totalCostUsd: number | undefined
  let resolved = false

  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })

      const finishOnce = () => {
        if (resolved) return
        resolved = true
        try {
          if (textBlockId) {
            controller.enqueue({ type: "text-end", id: textBlockId })
            textBlockId = null
          }
          controller.enqueue({
            type: "finish",
            usage,
            finishReason,
            providerMetadata: {
              "claude-code": {
                sessionId: sessionId ?? null,
                totalCostUsd: totalCostUsd ?? 0,
              },
            },
          })
          controller.close()
        } catch {}
      }

      const startTextBlock = () => {
        if (!textBlockId) {
          textBlockId = `text-${Date.now()}`
          controller.enqueue({ type: "text-start", id: textBlockId })
        }
      }

      child.stdout.setEncoding("utf-8")
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          try {
            const ev = JSON.parse(line) as ClaudeStreamEvent
            handleStreamEvent(ev)
          } catch {
            // ignore non-JSON
          }
        }
      })

      child.stderr.setEncoding("utf-8")
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000)
      })

      child.on("error", (err) => {
        if (resolved) return
        resolved = true
        try {
          controller.enqueue({ type: "error", error: err })
          controller.close()
        } catch {}
      })

      child.on("close", (code) => {
        if (code !== 0 && !finalText) {
          if (!resolved) {
            resolved = true
            try {
              controller.enqueue({
                type: "error",
                error: new Error(`Claude CLI failed (exit ${code}): ${stderrBuf.trim().slice(0, 500)}`),
              })
              controller.close()
            } catch {}
          }
          return
        }
        finishOnce()
      })

      function handleStreamEvent(ev: ClaudeStreamEvent) {
        if (ev.type === "system" && ev.subtype === "init") {
          sessionId = (ev as any).session_id
          if ((ev as any).model) modelId = (ev as any).model
          controller.enqueue({
            type: "response-metadata",
            id: messageId,
            modelId,
            timestamp: new Date(),
          })
          return
        }
        if (ev.type === "stream_event" && ev.event) {
          // Partial message: content_block_delta / text_delta
          const inner = ev.event
          if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
            startTextBlock()
            controller.enqueue({ type: "text-delta", id: textBlockId!, delta: inner.delta.text })
            finalText += inner.delta.text
          }
          return
        }
        if (ev.type === "assistant" && ev.message) {
          if (ev.message.id) messageId = ev.message.id
          if (ev.message.model) modelId = ev.message.model
          // If --include-partial-messages is on, the deltas already arrived via
          // stream_event events above. The assistant event still fires once
          // per message with the full final content. We use it only to capture
          // the FINAL text in case partials were never emitted (CLI fallback).
          if (ev.message.content) {
            const fullText = ev.message.content
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text!)
              .join("")
            if (fullText && !finalText) {
              startTextBlock()
              controller.enqueue({ type: "text-delta", id: textBlockId!, delta: fullText })
              finalText = fullText
            }
          }
          if (ev.message.usage) usage = mapUsage(ev.message.usage, usage)
          return
        }
        if (ev.type === "result") {
          if (typeof ev.result === "string" && !finalText) {
            startTextBlock()
            controller.enqueue({ type: "text-delta", id: textBlockId!, delta: ev.result })
            finalText = ev.result
          }
          finishReason = mapStopReason(ev.stop_reason)
          totalCostUsd = ev.total_cost_usd
          if (ev.usage) usage = mapUsage(ev.usage, usage)
          return
        }
        // rate_limit_event, system/hook_*, etc. — ignored
      }
    },

    cancel(reason) {
      try {
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
        }, 1500)
      } catch {}
      if (abortSignal && !abortSignal.aborted) {
        // Caller-driven cancellation, propagate
      }
    },
  })
}

// ────────────────────────────────────────────────────────────────────
// Mapping helpers
// ────────────────────────────────────────────────────────────────────

function mapUsage(
  cliUsage: NonNullable<ClaudeStreamEvent["usage"]>,
  prev: LanguageModelV2Usage,
): LanguageModelV2Usage {
  const inputTokens = cliUsage.input_tokens ?? prev.inputTokens
  const outputTokens = cliUsage.output_tokens ?? prev.outputTokens
  const cachedInputTokens = cliUsage.cache_read_input_tokens ?? prev.cachedInputTokens
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens + (cachedInputTokens ?? 0) + (cliUsage.cache_creation_input_tokens ?? 0)
      : prev.totalTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
  }
}

function mapStopReason(reason: string | undefined): LanguageModelV2FinishReason {
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
    default:
      return "unknown"
  }
}
