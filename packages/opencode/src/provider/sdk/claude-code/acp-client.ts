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
  /** Absolute path to the `claude` CLI. Its parent dir is prepended to the
   *  child PATH so the ACP adapter (which shells out to `claude`) finds
   *  the right binary even when our PATH is missing the user's install dir. */
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
  // Production (Electron packaged build): main process pre-stages the
  // adapter to process.resourcesPath/claude-code-acp/ via
  // scripts/stage-claude-acp.ts and exposes the absolute path through
  // OPENCODE_CLAUDE_CODE_ACP_ENTRY. The sidecar (single-binary
  // bun-compile artifact) cannot resolve npm modules itself.
  const fromEnv = process.env.OPENCODE_CLAUDE_CODE_ACP_ENTRY
  if (fromEnv) {
    log.info("adapter entry from env", { path: fromEnv })
    return fromEnv
  }
  // Dev / CLI direct invocation: walk workspace symlinks via Bun's resolver.
  const dir = typeof import.meta !== "undefined" && import.meta.dir ? import.meta.dir : process.cwd()
  try {
    return Bun.resolveSync("@zed-industries/claude-code-acp/dist/index.js", dir)
  } catch (e) {
    throw new Error(
      `Cannot find @zed-industries/claude-code-acp adapter. ` +
        `In production this is shipped via electron-builder extraResources and the path passed via ` +
        `OPENCODE_CLAUDE_CODE_ACP_ENTRY (currently unset). In dev, run \`bun install\` first. ` +
        `Underlying: ${(e as Error).message}`,
    )
  }
}

function makeChildEnv(claudeCliPath?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Strip CLAUDECODE / CLAUDE_CODE_* — the adapter refuses to start
    // when those are set (it thinks it'd be a nested session).
    if (k.startsWith("CLAUDECODE") || k.startsWith("CLAUDE_CODE_")) continue
    if (typeof v === "string") env[k] = v
  }
  // If we know the absolute path of the `claude` binary (from
  // detectClaudeCli), prepend its directory to PATH so the ACP adapter
  // child process — which internally spawns `claude` — finds it. Without
  // this the adapter inherits our (possibly PATH-less) env and bails with
  // "claude: not found" even though the user has it in ~/.local/bin.
  if (claudeCliPath) {
    const sep = process.platform === "win32" ? ";" : ":"
    const lastSlash = Math.max(claudeCliPath.lastIndexOf("/"), claudeCliPath.lastIndexOf("\\"))
    if (lastSlash > 0) {
      const dir = claudeCliPath.slice(0, lastSlash)
      env.PATH = dir + sep + (env.PATH || env.Path || "")
      // Windows env can be Path or PATH; normalize.
      if ("Path" in env) env.Path = env.PATH
    }
  }
  return env
}

function findNodeRuntime(): string {
  // The sidecar (opencode-cli) is a bun --compile single-binary artifact,
  // so process.execPath can NOT execute arbitrary .js files. We need a
  // real Node interpreter. Probe common locations:
  //   - $OPENCODE_NODE_BINARY override
  //   - Common Windows install dirs (absolute paths first — more reliable
  //     than bare `node` because the sidecar's PATH often lacks them)
  //   - bare `node` (PATH) as last resort
  const override = process.env["OPENCODE_NODE_BINARY"]
  if (override) return override
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
      `${process.env.LOCALAPPDATA}\\Programs\\nodejs\\node.exe`,
      `${process.env.APPDATA}\\nvm\\node.exe`,
    ]
    const fs = require("node:fs") as typeof import("node:fs")
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {}
    }
    return "node" // fallback to PATH; sync verify happens in verifyNodeAvailable()
  }
  return "node"
}

/** Sync check — does `<nodeBin> --version` actually succeed? Throws with
 *  a user-friendly message if not, so the chat surfaces an actionable
 *  error instead of hanging forever in "Thinking…".
 *
 *  IMPORTANT: on Windows we ALWAYS use shell:true. Without it, an
 *  absolute path containing a space ("C:\Program Files\nodejs\node.exe")
 *  fails with exit=null because spawnSync passes the path unquoted to
 *  CreateProcess and Windows treats "C:\Program" as the executable. With
 *  shell:true, cmd.exe handles the quoting via PATHEXT resolution. */
function verifyNodeAvailable(nodeBin: string): void {
  const sync = require("node:child_process").spawnSync as typeof import("node:child_process").spawnSync
  const useShell = process.platform === "win32"
  // When using shell on win32, cmd /c needs the path quoted if it has spaces.
  const cmd = useShell && nodeBin.includes(" ") ? `"${nodeBin}"` : nodeBin
  try {
    const r = sync(cmd, ["--version"], {
      timeout: 5000,
      shell: useShell,
      windowsHide: true,
    })
    if (r.error) {
      throw new Error(`spawn error: ${(r.error as any).code || r.error.message}`)
    }
    if (r.status !== 0) {
      throw new Error(
        `exit ${r.status} signal=${r.signal}: stderr="${(r.stderr ?? "").toString().slice(0, 200)}" stdout="${(r.stdout ?? "").toString().slice(0, 200)}"`,
      )
    }
    log.info("node verified", { bin: nodeBin, version: (r.stdout ?? "").toString().trim() })
  } catch (e: any) {
    throw new Error(
      `Node.js runtime not found (tried: ${nodeBin}). Install Node 18+ from https://nodejs.org ` +
        `or set OPENCODE_NODE_BINARY=<absolute path to node.exe>. ` +
        `Underlying: ${e?.code || e?.message || String(e).slice(0, 200)}`,
    )
  }
}

function spawnAdapter(opts: AcpClientOptions): SharedAdapter {
  const adapterEntry = opts.adapterEntry || resolveAdapterEntry()
  const nodeBin = findNodeRuntime()
  // Fail fast if Node is missing — without this check the spawn would
  // succeed at OS level (ENOENT comes async) and our `ready` promise
  // would await initialize() forever, leaving the chat UI in
  // "Thinking…" with no error. The user reported exactly this hang on
  // v2.41.5: "ciao" → Riflessione → loop infinito.
  verifyNodeAvailable(nodeBin)
  log.info("spawning adapter", { entry: adapterEntry, node: nodeBin })

  // Always use shell on win32 — both for bare `node` (PATHEXT resolves
  // node.exe) AND for absolute paths with spaces (e.g. "C:\Program
  // Files\nodejs\node.exe", which fails with exit=null when shell:false
  // because CreateProcess sees "C:\Program" as the executable). cmd.exe
  // handles quoting correctly when we wrap the path in double quotes.
  const useShell = process.platform === "win32"
  const cmd = useShell && nodeBin.includes(" ") ? `"${nodeBin}"` : nodeBin
  // When shell:true on win32, args also need quoting if they have spaces
  // — but adapterEntry from process.resourcesPath might be in
  // "C:\Program Files\OpenCode\..." so quote it too.
  const args = useShell && adapterEntry.includes(" ") ? [`"${adapterEntry}"`] : [adapterEntry]
  const child = spawn(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: makeChildEnv(opts.claudeCliPath),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: useShell,
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
    child.on("error", (err: any) => {
      log.warn("adapter error", { err: String(err) })
      // Surface ENOENT as a clear "install Node" message — this is the
      // path users hit if they don't have Node.js installed and we
      // failed to spawn the runtime. Without this they see a cryptic
      // "Cannot find module" or "spawn ENOENT" error.
      if (err?.code === "ENOENT") {
        log.warn(
          "Node.js runtime not found. Install Node 18+ from https://nodejs.org " +
            "or set OPENCODE_NODE_BINARY=<absolute path to node.exe>",
        )
      }
    })
  })

  // Cold-start timeout: the adapter has to boot Node + load
  // claude-code-acp + handshake protocol with us. On a fast machine this
  // is ~2s, on a slow one ~10-15s. 60s is generous and bounded — beyond
  // that something is wrong (adapter crashed silently, ACP version
  // mismatch, etc.) and we'd rather error than hang the chat forever.
  const READY_TIMEOUT_MS = 60_000
  const ready = (async () => {
    const result = await Promise.race([
      conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `ACP adapter did not respond to initialize() within ${READY_TIMEOUT_MS / 1000}s. ` +
                  `Check that Node.js is installed and the bundle at ${adapterEntry} is intact. ` +
                  `Try: \`node ${adapterEntry}\` in a terminal — should print JSON-RPC notifications.`,
              ),
            ),
          READY_TIMEOUT_MS,
        ),
      ),
    ])
    log.info("initialize ok", {
      protocolVersion: result.protocolVersion,
      hasModes: Array.isArray((result as any).availableModes),
    })
  })().catch((err) => {
    // Reset the singleton so the next attempt re-spawns instead of
    // re-using a dead/half-init'd adapter. Re-throw so callers see the
    // real failure.
    log.warn("adapter init failed", { err: String(err) })
    if (_shared?.child === child) {
      try { child.kill("SIGKILL") } catch {}
      _shared = null
    }
    throw err
  })

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
      // Hard cap: 5 minutes per turn. Real Claude responses (even with
      // tool-use loops) finish in <60s on Pro/Max. Anything beyond 5min
      // means the adapter or Claude is wedged and we'd rather error
      // than leave the chat in "Thinking…" forever.
      const PROMPT_TIMEOUT_MS = 5 * 60_000
      try {
        const res = await Promise.race([
          s.conn.prompt({ sessionId, prompt: blocks }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Claude Code agent did not finish within ${PROMPT_TIMEOUT_MS / 1000 / 60} minutes. ` +
                      `Likely causes: subscription quota exhausted (resets at 8am Europe/Rome), ` +
                      `network issue, or the adapter wedged. Check the diagnostic log.`,
                  ),
                ),
              PROMPT_TIMEOUT_MS,
            ),
          ),
        ])
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
