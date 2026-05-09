// Singleton ACP client — manages one long-lived `@zed-industries/claude-code-acp`
// subprocess + JSON-RPC connection for the entire CrimeCode process. All
// `ClaudeCodeLanguageModel` instances share this client, so we only pay
// the adapter cold-start cost once (~10s) instead of per-request.
//
// Why this exists:
// The CLI-subprocess approach (claude --print stream-json per request) has
// 1.5–3s startup overhead per call and can't surface tool calls to the
// client. The ACP adapter exposes Claude Code as a stateful agent over
// JSON-RPC stdio, so requests after the first one have ~0 startup, tool
// calls become visible to CrimeCode, and the agent can use its native
// tools (Read/Edit/Bash/Grep/etc.) directly without us re-implementing
// them.
//
// Lifecycle:
//   1. detectClaudeCli() succeeds (CLI installed + logged in)
//   2. ensureClient() lazily spawns the adapter, performs initialize()
//   3. acquireSession() creates a fresh session for each prompt turn
//      (the AI SDK ships full conversation history per call, so session
//      continuity at the adapter level isn't useful for us — we use
//      throw-away sessions and let the SDK manage history)
//   4. Subprocess stays alive until shutdown() or process exit

import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { readFileSync, writeFileSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"
import { Log } from "../../../util/log"
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type ContentBlock,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk"

const log = Log.create({ service: "claude-code-acp" })

// ────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────

export interface AcpSessionHandle {
  readonly sessionId: string
  /** Send a prompt turn; emits stream parts via the provided callback. */
  prompt(blocks: ContentBlock[], onUpdate: (n: SessionNotification) => void): Promise<{
    stopReason: string
    /** Tokens reported by the agent, if available. */
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  }>
  cancel(): Promise<void>
  /** Release adapter resources for this session. */
  close(): Promise<void>
}

export interface AcpClientOptions {
  /** Working directory passed to the agent's newSession. Default: process.cwd(). */
  cwd?: string
  /** Override path to claude-code-acp/dist/index.js (else resolved via Bun). */
  adapterEntry?: string
  /** Override path to the `claude` CLI binary (forwarded as PATH). */
  claudeCliPath?: string
}

// ────────────────────────────────────────────────────────────────────
// Internal: shared singleton process
// ────────────────────────────────────────────────────────────────────

interface SharedAdapter {
  child: ChildProcessWithoutNullStreams
  conn: ClientSideConnection
  /** Per-session callback registry — keyed by ACP sessionId. */
  router: Map<string, (n: SessionNotification) => void>
  /** Promise that resolves once `initialize()` succeeds. */
  ready: Promise<void>
  /** Promise that resolves when the subprocess exits (clean or crash). */
  closed: Promise<void>
}

let _shared: SharedAdapter | null = null

function resolveAdapterEntry(): string {
  // Bun.resolveSync walks the workspace symlinks; works in dev (workspace),
  // electron-builder bundle (extracted to resources/app), and CI builds.
  const dir = typeof import.meta !== "undefined" && import.meta.dir
    ? import.meta.dir
    : process.cwd()
  return Bun.resolveSync("@zed-industries/claude-code-acp/dist/index.js", dir)
}

function makeChildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Strip CLAUDECODE / CLAUDE_CODE_* — the adapter refuses to start
    // when those are set (it thinks it'd be a nested session).
    if (k.startsWith("CLAUDECODE") || k.startsWith("CLAUDE_CODE_")) continue
    if (typeof v === "string") env[k] = v
  }
  return env
}

function spawnAdapter(opts: AcpClientOptions): SharedAdapter {
  const adapterEntry = opts.adapterEntry || resolveAdapterEntry()
  log.info("spawning adapter", { entry: adapterEntry })

  const child = spawn(process.execPath, [adapterEntry], {
    cwd: opts.cwd || process.cwd(),
    env: makeChildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams

  // Forward adapter stderr to our log at debug level (it's chatty).
  child.stderr.setEncoding("utf-8")
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) log.info("adapter stderr", { line: line.slice(0, 200) })
    }
  })

  // WHATWG stream wrappers around child.stdin/stdout for ndJsonStream.
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      child.stdout.on("end", () => {
        try { controller.close() } catch {}
      })
      child.stdout.on("error", (err) => {
        try { controller.error(err) } catch {}
      })
    },
  })
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(chunk, (err) => (err ? reject(err) : resolve()))
      })
    },
  })

  const stream = ndJsonStream(input, output)

  // The Client we expose to the agent: handles permission requests,
  // file IO, and session updates. Per-session update routing is done via
  // a Map keyed by sessionId so multiple concurrent sessions work.
  const router = new Map<string, (n: SessionNotification) => void>()
  const clientImpl: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const cb = router.get(params.sessionId)
      if (cb) cb(params)
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      // CrimeCode auto-approves all tool calls. The agent's own tool list
      // is curated (Read/Edit/Bash/Grep/Glob/Write/Task/etc.) and the
      // user already sees them via tool_call notifications. If a future
      // version wants per-call confirmation, hook the IDE permission UI
      // here.
      const opt = params.options.find((o) => o.kind === "allow_once")
        ?? params.options.find((o) => o.kind === "allow_always")
        ?? params.options[0]
      log.info("auto-approve tool call", {
        title: params.toolCall.title,
        option: opt?.name,
      })
      return { outcome: { outcome: "selected", optionId: opt!.optionId } }
    },
    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      // Requested by the agent when it advertises fs.readTextFile capability.
      // Bound to the client's filesystem (CrimeCode's process), not the
      // agent's. Use sync IO + UTF-8 like the rest of opencode.
      try {
        const content = readFileSync(params.path, "utf-8")
        if (params.line !== undefined || params.limit !== undefined) {
          const lines = content.split("\n")
          const start = Math.max(0, (params.line ?? 1) - 1)
          const end = params.limit ? Math.min(lines.length, start + params.limit) : lines.length
          return { content: lines.slice(start, end).join("\n") }
        }
        return { content }
      } catch (e) {
        log.warn("readTextFile failed", { path: params.path, err: String(e) })
        throw e
      }
    },
    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      try {
        // Ensure parent dir exists (mkdir -p semantics) so the agent
        // can create files in fresh subdirs without us pre-creating.
        try {
          statSync(dirname(params.path))
        } catch {
          mkdirSync(dirname(params.path), { recursive: true })
        }
        writeFileSync(params.path, params.content)
        return null as unknown as WriteTextFileResponse
      } catch (e) {
        log.warn("writeTextFile failed", { path: params.path, err: String(e) })
        throw e
      }
    },
  }

  const conn = new ClientSideConnection((_agent: Agent) => clientImpl, stream)

  const closed = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      log.info("adapter exited", { code })
      _shared = null
      resolve()
    })
    child.on("error", (err) => {
      log.warn("adapter error", { err: String(err) })
    })
  })

  const ready = (async () => {
    const init = await conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })
    log.info("initialize ok", {
      protocolVersion: init.protocolVersion,
      hasModes: Array.isArray((init as any).availableModes),
    })
  })()

  return { child, conn, router, ready, closed }
}

export function ensureAcpClient(opts: AcpClientOptions = {}): SharedAdapter {
  if (_shared) return _shared
  _shared = spawnAdapter(opts)
  return _shared
}

export async function shutdownAcpClient(): Promise<void> {
  const s = _shared
  if (!s) return
  try {
    s.child.kill("SIGTERM")
    setTimeout(() => {
      try {
        if (!s.child.killed) s.child.kill("SIGKILL")
      } catch {}
    }, 1500)
  } catch {}
  await s.closed.catch(() => {})
  _shared = null
}

// ────────────────────────────────────────────────────────────────────
// Per-call session handle
// ────────────────────────────────────────────────────────────────────

export async function acquireSession(opts: AcpClientOptions = {}): Promise<AcpSessionHandle> {
  const s = ensureAcpClient(opts)
  await s.ready

  const session = await s.conn.newSession({
    cwd: opts.cwd || process.cwd(),
    mcpServers: [],
  })
  const sessionId = session.sessionId
  log.info("session created", { sessionId })

  let onUpdate: ((n: SessionNotification) => void) | null = null
  s.router.set(sessionId, (n: SessionNotification) => onUpdate?.(n))

  return {
    sessionId,
    async prompt(blocks: ContentBlock[], cb: (n: SessionNotification) => void) {
      onUpdate = cb
      try {
        const res = await s.conn.prompt({ sessionId, prompt: blocks })
        return {
          stopReason: res.stopReason,
          usage: extractUsage(res),
        }
      } finally {
        onUpdate = null
      }
    },
    async cancel() {
      try {
        await s.conn.cancel({ sessionId })
      } catch (e) {
        log.warn("cancel failed", { err: String(e) })
      }
    },
    async close() {
      s.router.delete(sessionId)
      // The ACP spec doesn't have an explicit "close session" RPC — the
      // adapter cleans up when the connection drops, and individual
      // sessions are GC'd when no further prompts come in. Just unsubscribe.
    },
  }
}

function extractUsage(res: any): { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined {
  // ACP doesn't standardize a usage shape; the adapter forwards Claude's
  // usage in the prompt response under various keys depending on version.
  const u = res?.usage ?? res?._meta?.usage
  if (!u) return undefined
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
    cachedInputTokens:
      typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
  }
}

// Cleanup on process exit (best-effort; works for SIGINT/SIGTERM/normal exit).
for (const sig of ["SIGINT", "SIGTERM", "exit"]) {
  process.on(sig as any, () => {
    void shutdownAcpClient()
  })
}
