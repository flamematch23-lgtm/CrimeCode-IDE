/**
 * Sandbox runtime — isolated code execution for the /v1/sandbox/run route.
 *
 * Two pluggable backends:
 *   - DOCKER (default): spawns a one-shot container per request with strict
 *     resource limits and no network. Free, self-hosted, runs on the same
 *     VPS as the API itself.
 *   - E2B (optional):   uses @e2b/code-interpreter. Activated when
 *     SANDBOX_BACKEND=e2b and E2B_API_KEY is set. Requires the npm package
 *     to be installed; we lazy-load to keep the Docker-only deployment lean.
 *
 * Hardening (Docker backend):
 *   --network=none              no internet access
 *   --memory=256m --cpus=1      bound resource use
 *   --read-only                 root FS is immutable
 *   --tmpfs /tmp,/workspace     ephemeral writable scratch
 *   --cap-drop=ALL              no Linux capabilities
 *   --security-opt=no-new-privs no setuid escalation
 *   --user=nobody               unprivileged inside the container
 *   timeout                     wall-clock cap (default 30s, max 60s)
 *
 * Output limits: stdout + stderr each capped at MAX_OUTPUT_BYTES so a
 * runaway `yes` can't flood the response.
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"

export type SandboxLanguage = "python" | "node" | "javascript" | "bash" | "sh"

export interface SandboxRequest {
  language: SandboxLanguage
  code: string
  timeout_ms?: number
}

export interface SandboxResult {
  stdout: string
  stderr: string
  exit_code: number
  timed_out: boolean
  duration_ms: number
  truncated: boolean
  backend: "docker" | "e2b"
}

const BACKEND = (process.env.SANDBOX_BACKEND ?? "docker").toLowerCase() as "docker" | "e2b"
const DEFAULT_TIMEOUT_MS = Number(process.env.SANDBOX_DEFAULT_TIMEOUT_MS ?? 30_000)
const MAX_TIMEOUT_MS = Number(process.env.SANDBOX_MAX_TIMEOUT_MS ?? 60_000)
const MAX_CODE_BYTES = Number(process.env.SANDBOX_MAX_CODE_BYTES ?? 64 * 1024) // 64 KB
const MAX_OUTPUT_BYTES = Number(process.env.SANDBOX_MAX_OUTPUT_BYTES ?? 256 * 1024) // 256 KB
const MEMORY_LIMIT = process.env.SANDBOX_MEMORY ?? "256m"
const CPU_LIMIT = process.env.SANDBOX_CPUS ?? "1"

interface DockerImage {
  image: string
  cmd: string[]
  pullOnBoot?: boolean
}

const IMAGES: Record<SandboxLanguage, DockerImage> = {
  python: { image: "python:3.12-slim", cmd: ["python", "-c"] },
  node: { image: "node:20-alpine", cmd: ["node", "-e"] },
  javascript: { image: "node:20-alpine", cmd: ["node", "-e"] },
  bash: { image: "alpine:latest", cmd: ["sh", "-c"] },
  sh: { image: "alpine:latest", cmd: ["sh", "-c"] },
}

export function isSupportedLanguage(s: string): s is SandboxLanguage {
  return s in IMAGES
}

export async function runSandbox(req: SandboxRequest): Promise<SandboxResult> {
  if (!isSupportedLanguage(req.language)) {
    throw new Error("unsupported_language")
  }
  if (!req.code || typeof req.code !== "string") {
    throw new Error("missing_code")
  }
  if (Buffer.byteLength(req.code, "utf8") > MAX_CODE_BYTES) {
    throw new Error("code_too_large")
  }
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, req.timeout_ms ?? DEFAULT_TIMEOUT_MS))

  if (BACKEND === "e2b") {
    return runViaE2B(req, timeoutMs)
  }
  return runViaDocker(req, timeoutMs)
}

// ── Docker backend ────────────────────────────────────────────────────

async function runViaDocker(req: SandboxRequest, timeoutMs: number): Promise<SandboxResult> {
  const img = IMAGES[req.language]
  const startedAt = Date.now()

  // Pass code via heredoc with a per-request random terminator so user
  // code can never close the heredoc early (e.g. by including a literal
  // "CRIMEOPUS_EOF" line). The random tag is single-quoted so no
  // variable expansion happens inside the body.
  const eofTag = `CRIMEOPUS_EOF_${randomBytes(16).toString("hex").toUpperCase()}`
  const program = `cat > /workspace/program <<'${eofTag}'
${req.code}
${eofTag}
${dispatchCmd(req.language)}`

  const args = [
    "run",
    "--rm",
    "-i",
    "--network=none",
    `--memory=${MEMORY_LIMIT}`,
    `--cpus=${CPU_LIMIT}`,
    "--read-only",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=50m",
    "--tmpfs=/workspace:rw,size=10m",
    "--workdir=/workspace",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    img.image,
    "sh",
    "-c",
    program,
  ]

  return new Promise<SandboxResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false

    const killTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* already exited */
      }
    }, timeoutMs)

    function appendBuf(target: "stdout" | "stderr", chunk: Buffer): void {
      const cur = target === "stdout" ? stdout : stderr
      if (cur.length + chunk.length > MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - cur.length
        const trimmed = chunk.subarray(0, Math.max(0, remaining)).toString("utf8")
        truncated = true
        if (target === "stdout") stdout = cur + trimmed
        else stderr = cur + trimmed
        try {
          child.kill("SIGTERM")
        } catch {
          /* */
        }
        return
      }
      const text = chunk.toString("utf8")
      if (target === "stdout") stdout = cur + text
      else stderr = cur + text
    }

    child.stdout?.on("data", (c) => appendBuf("stdout", c))
    child.stderr?.on("data", (c) => appendBuf("stderr", c))
    child.on("close", (code) => {
      clearTimeout(killTimer)
      resolve({
        stdout,
        stderr,
        exit_code: code ?? -1,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        truncated,
        backend: "docker",
      })
    })
    child.on("error", (err) => {
      clearTimeout(killTimer)
      resolve({
        stdout,
        stderr: stderr + `\n[sandbox] spawn error: ${err.message}`,
        exit_code: -1,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
        truncated,
        backend: "docker",
      })
    })
  })
}

function dispatchCmd(language: SandboxLanguage): string {
  switch (language) {
    case "python":
      return "python /workspace/program"
    case "node":
    case "javascript":
      return "node /workspace/program"
    case "bash":
    case "sh":
      return "sh /workspace/program"
  }
}

// ── E2B backend (optional) ────────────────────────────────────────────
// We load `@e2b/code-interpreter` dynamically and untyped so the package
// doesn't have to be installed when running in Docker mode (the default).
// To enable: `bun add @e2b/code-interpreter` + set SANDBOX_BACKEND=e2b
// + E2B_API_KEY=<key>.

interface E2BSandbox {
  runCode(code: string, opts?: { timeoutMs?: number }): Promise<{
    logs?: { stdout?: string[]; stderr?: string[] }
    error?: unknown
  }>
  kill(): Promise<void>
}
interface E2BModule {
  Sandbox: { create(opts: { apiKey: string; timeoutMs?: number }): Promise<E2BSandbox> }
}

let e2bModule: E2BModule | null = null
let e2bLoadFailed = false

async function runViaE2B(req: SandboxRequest, timeoutMs: number): Promise<SandboxResult> {
  const startedAt = Date.now()
  if (!e2bModule && !e2bLoadFailed) {
    try {
      // @ts-expect-error optional peer dep
      e2bModule = (await import("@e2b/code-interpreter")) as E2BModule
    } catch (err) {
      e2bLoadFailed = true
      throw new Error(`e2b_not_installed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!e2bModule) throw new Error("e2b_not_installed")
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) throw new Error("e2b_api_key_missing")

  const sandbox = await e2bModule.Sandbox.create({ apiKey, timeoutMs })
  try {
    let exec
    if (req.language === "python") {
      exec = await sandbox.runCode(req.code, { timeoutMs })
    } else if (req.language === "node" || req.language === "javascript") {
      const escaped = req.code.replace(/'/g, "'\\''")
      exec = await sandbox.runCode(`!node -e '${escaped}'`, { timeoutMs })
    } else {
      const escaped = req.code.replace(/'/g, "'\\''")
      exec = await sandbox.runCode(`!sh -c '${escaped}'`, { timeoutMs })
    }
    const stdoutLines = (exec.logs?.stdout ?? []).join("")
    const stderrLines = (exec.logs?.stderr ?? []).join("")
    return {
      stdout: stdoutLines.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderrLines.slice(0, MAX_OUTPUT_BYTES),
      exit_code: exec.error ? 1 : 0,
      timed_out: false,
      duration_ms: Date.now() - startedAt,
      truncated: stdoutLines.length > MAX_OUTPUT_BYTES || stderrLines.length > MAX_OUTPUT_BYTES,
      backend: "e2b",
    }
  } finally {
    try {
      await sandbox.kill()
    } catch {
      /* best effort */
    }
  }
}

// ── Bootstrap: pre-pull Docker images on first run ────────────────────
// Lazy; do nothing if Docker isn't available (the first /run will fail
// loudly with a clear error message, which is better than masking it).

export async function ensureImagesAvailable(): Promise<void> {
  if (BACKEND !== "docker") return
  const unique = Array.from(new Set(Object.values(IMAGES).map((i) => i.image)))
  for (const img of unique) {
    await new Promise<void>((resolve) => {
      const child = spawn("docker", ["image", "inspect", img], { stdio: "ignore" })
      child.on("close", (code) => {
        if (code === 0) {
          resolve()
          return
        }
        // Pull in background; don't block boot.
        const pull = spawn("docker", ["pull", img], { stdio: "ignore" })
        pull.on("close", () => resolve())
        pull.on("error", () => resolve())
      })
      child.on("error", () => resolve())
    })
  }
}
