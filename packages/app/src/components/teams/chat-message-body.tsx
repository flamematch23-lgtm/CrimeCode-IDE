/**
 * ChatMessageBody — renders a chat message text, parsing fenced code blocks
 * (```lang\ncode\n```) into separate UI blocks with inline action buttons.
 *
 * Buttons rendered per code block:
 *   📋 Copia        → write the code to the system clipboard
 *   ▶ Esegui        → POST the code to the CrimeOpus sandbox endpoint
 *                    (Docker-isolated by default, optional E2B). The result
 *                    (stdout / stderr / exit code) is rendered inline below
 *                    the block, so the conversation stays compact.
 *   ⚡ Esegui (AI)  → injects the code into the active prompt input as a
 *                    request to the AI to run it. Useful when the local
 *                    sandbox is offline or for code that needs project
 *                    context (file reads, env vars, etc.).
 */
import { For, Show, createSignal, onCleanup } from "solid-js"

interface Block {
  kind: "text" | "code"
  language?: string
  content: string
}

const FENCE_RE = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g

export function parseChatBody(text: string): Block[] {
  const out: Block[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  FENCE_RE.lastIndex = 0
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: "text", content: text.slice(lastIndex, m.index) })
    }
    out.push({ kind: "code", language: m[1] || "text", content: m[2] })
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) {
    out.push({ kind: "text", content: text.slice(lastIndex) })
  }
  return out
}

function copy(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

interface SandboxResult {
  stdout: string
  stderr: string
  exit_code: number
  timed_out: boolean
  duration_ms: number
  truncated: boolean
  backend: "docker" | "e2b"
}

const SANDBOX_BASE = (() => {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
  return (meta?.env?.VITE_SANDBOX_URL ?? "https://ai.crimecode.cc").replace(/\/+$/, "")
})()

const SANDBOX_LANGUAGE_MAP: Record<string, string> = {
  python: "python",
  py: "python",
  python3: "python",
  node: "node",
  nodejs: "node",
  javascript: "javascript",
  js: "javascript",
  bash: "bash",
  sh: "sh",
  shell: "bash",
}

function mapToSandboxLanguage(language: string | undefined): string | null {
  if (!language) return null
  return SANDBOX_LANGUAGE_MAP[language.toLowerCase()] ?? null
}

/**
 * Resolve a CrimeOpus API key for the sandbox endpoint. Priority order:
 *   1) `crimeopus.sandbox.api_key` localStorage (user-set or imported)
 *   2) Auth context exposed by the desktop preload (window.api.providerAuth)
 *      — falls back gracefully when running in a browser
 *   3) Prompt the user once, persist the answer to localStorage
 * Returns null if the user cancels the prompt; the caller surfaces the
 * resulting 401 with a clear error message.
 */
async function resolveSandboxApiKey(): Promise<string | null> {
  let apiKey = ""
  try {
    apiKey = (localStorage.getItem("crimeopus.sandbox.api_key") ?? "").trim()
  } catch {
    /* private mode */
  }
  if (apiKey) return apiKey

  // Try the desktop IPC bridge — preload may expose the saved CrimeOpus
  // provider key from the user's auth.json without going through the UI.
  try {
    const desktop = (window as unknown as {
      api?: { providerAuth?: (id: string) => Promise<{ apiKey?: string } | null> }
    }).api
    if (desktop?.providerAuth) {
      const r = await desktop.providerAuth("crimeopus")
      if (r?.apiKey) {
        try {
          localStorage.setItem("crimeopus.sandbox.api_key", r.apiKey)
        } catch {
          /* private mode */
        }
        return r.apiKey
      }
    }
  } catch {
    /* preload missing or rejected — fall through */
  }

  // Last resort: ask the user. Only fires once; subsequent calls hit
  // localStorage. They can clear it from DevTools if they need to rotate.
  if (typeof window === "undefined" || typeof window.prompt !== "function") return null
  const entered = window.prompt(
    "Per eseguire codice in sandbox serve la tua API key CrimeOpus.\n\nIncolla qui la chiave (verrà salvata in locale solo per questo browser):",
  )
  if (!entered || !entered.trim()) return null
  const trimmed = entered.trim()
  try {
    localStorage.setItem("crimeopus.sandbox.api_key", trimmed)
  } catch {
    /* private mode */
  }
  return trimmed
}

async function runInSandbox(
  language: string,
  code: string,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const apiKey = await resolveSandboxApiKey()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
  const res = await fetch(`${SANDBOX_BASE}/v1/sandbox/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ language, code, timeout_ms: 30_000 }),
    signal,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    if (res.status === 401) {
      // Clear the bad key so the next click re-prompts.
      try {
        localStorage.removeItem("crimeopus.sandbox.api_key")
      } catch {
        /* */
      }
      throw new Error("API key non valida o mancante. Verrai chiesto di reinserirla al prossimo click.")
    }
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200) || "sandbox call failed"}`)
  }
  return (await res.json()) as SandboxResult
}

/**
 * Inject `code` into the visible prompt input as a "run this" request to
 * the AI. We locate the current contenteditable and APPEND new text nodes
 * — never `el.innerText = ...` — because that would obliterate any pill
 * elements (file refs, @agents, context items) the user already inserted
 * in their draft.
 *
 * The `[data-component="prompt-input"]` selector is a stable hook used
 * elsewhere in the codebase.
 */
function sendToPromptForExecution(code: string, language: string | undefined) {
  const el = document.querySelector<HTMLDivElement>('[data-component="prompt-input"]')
  if (!el) {
    alert("Apri prima una sessione per eseguire codice.")
    return
  }
  const langHint = language && language !== "text" ? language : "questo codice"
  const fence = "```"
  const wrapped =
    `Esegui ${langHint} e mostra l'output completo, inclusi eventuali errori. Se servono dipendenze, installale prima.\n\n` +
    `${fence}${language ?? ""}\n${code}\n${fence}`

  // Append-only: build a fragment with a leading separator (only if the
  // box already has content) and the wrapped instruction, mapping each
  // newline to a <br> so the contenteditable renders multi-line correctly.
  el.focus()
  const hasExisting = (el.innerText ?? "").trim().length > 0
  const fragment = document.createDocumentFragment()
  if (hasExisting) {
    fragment.appendChild(document.createElement("br"))
    fragment.appendChild(document.createElement("br"))
  }
  const lines = wrapped.split("\n")
  lines.forEach((line, i) => {
    if (line) fragment.appendChild(document.createTextNode(line))
    if (i < lines.length - 1) fragment.appendChild(document.createElement("br"))
  })
  el.appendChild(fragment)

  // Place caret at the end and notify listeners (CRDT binding, Solid
  // input handler) so prompt state stays consistent.
  try {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  } catch {
    /* selection apis can throw in obscure DOMs */
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
}

function CodeBlockView(props: { block: Block }) {
  const [running, setRunning] = createSignal(false)
  const [result, setResult] = createSignal<SandboxResult | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const sandboxLang = () => mapToSandboxLanguage(props.block.language)
  const canRun = () => sandboxLang() !== null

  let abortController: AbortController | null = null
  let mounted = true
  onCleanup(() => {
    mounted = false
    abortController?.abort()
  })

  async function onRun() {
    const lang = sandboxLang()
    if (!lang) return
    abortController?.abort()
    abortController = new AbortController()
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const r = await runInSandbox(lang, props.block.content, abortController.signal)
      if (!mounted) return
      setResult(r)
    } catch (ex) {
      if (!mounted) return
      // AbortError means the component unmounted or the user re-clicked
      // — neither is worth surfacing as an error message.
      if (ex instanceof DOMException && ex.name === "AbortError") return
      setError(ex instanceof Error ? ex.message : String(ex))
    } finally {
      if (mounted) setRunning(false)
    }
  }

  return (
    <div data-slot="code-block">
      <div data-slot="code-header">
        <span data-slot="code-lang">{props.block.language}</span>
        <div data-slot="code-actions">
          <button
            type="button"
            data-slot="code-action"
            onClick={() => copy(props.block.content)}
            title="Copia il codice negli appunti"
          >
            📋 Copia
          </button>
          <Show when={canRun()}>
            <button
              type="button"
              data-slot="code-action"
              data-variant="run"
              onClick={onRun}
              disabled={running()}
              title="Esegue il codice in un container Docker isolato (no network, 30s, 256MB)"
            >
              {running() ? "⏳ In esecuzione…" : "▶ Esegui"}
            </button>
          </Show>
          <button
            type="button"
            data-slot="code-action"
            data-variant="ai"
            onClick={() => sendToPromptForExecution(props.block.content, props.block.language)}
            title="Inserisci nel prompt input per chiedere all'AI di eseguire (utile per codice che necessita del contesto del progetto)"
          >
            ⚡ Esegui via AI
          </button>
        </div>
      </div>
      <pre data-slot="code-content">
        <code>{props.block.content}</code>
      </pre>
      <Show when={error()}>
        <div data-slot="sandbox-error">
          ⚠ {error()}
        </div>
      </Show>
      <Show when={result()}>
        {(r) => (
          <div
            data-slot="sandbox-result"
            data-exit={r().exit_code === 0 ? "ok" : "fail"}
            data-timeout={r().timed_out ? "true" : "false"}
          >
            <div data-slot="sandbox-meta">
              <span data-slot="sandbox-backend">{r().backend}</span>
              <span data-slot="sandbox-exit">exit {r().exit_code}</span>
              <span data-slot="sandbox-time">{r().duration_ms} ms</span>
              <Show when={r().timed_out}>
                <span data-slot="sandbox-tag" data-kind="warn">timed out</span>
              </Show>
              <Show when={r().truncated}>
                <span data-slot="sandbox-tag" data-kind="warn">output truncated</span>
              </Show>
            </div>
            <Show when={r().stdout}>
              <pre data-slot="sandbox-stream" data-stream="stdout">{r().stdout}</pre>
            </Show>
            <Show when={r().stderr}>
              <pre data-slot="sandbox-stream" data-stream="stderr">{r().stderr}</pre>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

export function ChatMessageBody(props: { text: string }) {
  const blocks = () => parseChatBody(props.text)
  return (
    <div data-slot="chat-body">
      <For each={blocks()}>
        {(b) => (
          <Show
            when={b.kind === "code"}
            fallback={<div data-slot="text-fragment">{b.content}</div>}
          >
            <CodeBlockView block={b} />
          </Show>
        )}
      </For>
    </div>
  )
}
