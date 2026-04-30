/**
 * ChatMessageBody — renders a chat message text, parsing fenced code blocks
 * (```lang\ncode\n```) into separate UI blocks with inline action buttons.
 *
 * Buttons rendered per code block:
 *   📋 Copia        → write the code to the system clipboard
 *   ⚡ Esegui (AI)  → injects the code into the active prompt input as a
 *                    request to the AI: "Esegui questo codice e mostra l'output"
 *                    The AI then runs it via its existing shell/python tools.
 *
 * Why route execution through the AI and not directly: a true cross-platform
 * sandbox (E2B / Daytona / Docker) is a separate effort. Routing through the
 * AI's existing tool calls works on day-one, picks up the user's environment
 * (project deps, env vars, files), and stays auditable in the session
 * timeline rather than opening a side-channel.
 */
import { For, Show } from "solid-js"

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

/**
 * Inject `code` into the visible prompt input as a "run this" request to
 * the AI. We locate the current contenteditable, append the wrapper text,
 * fire an `input` event so the host's existing prompt store updates, then
 * focus the box so the user can review and press Enter.
 *
 * This is intentionally low-level (DOM writes) rather than going through a
 * Solid context: the chat panel renders inside a portal on a separate route
 * tree, so it cannot easily share a prompt context. The `[data-component=
 * "prompt-input"]` selector is a stable hook used elsewhere in the codebase.
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
  // Focus first so the host's selection-tracking picks up the right anchor.
  el.focus()
  // Append rather than replace — the user may already be drafting something.
  const existing = (el.innerText ?? "").replace(/\n$/, "")
  const next = existing ? `${existing}\n\n${wrapped}` : wrapped
  el.innerText = next
  // Move caret to end and dispatch an input event so listeners (CRDT
  // binding, Solid input handler, etc.) sync state.
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  // Place caret at the end of the text.
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
            <div data-slot="code-block">
              <div data-slot="code-header">
                <span data-slot="code-lang">{b.language}</span>
                <div data-slot="code-actions">
                  <button
                    type="button"
                    data-slot="code-action"
                    onClick={() => copy(b.content)}
                    title="Copia il codice negli appunti"
                  >
                    📋 Copia
                  </button>
                  <button
                    type="button"
                    data-slot="code-action"
                    data-variant="run"
                    onClick={() => sendToPromptForExecution(b.content, b.language)}
                    title="Inserisci nel prompt input come richiesta all'AI di eseguire e mostrare output"
                  >
                    ⚡ Esegui via AI
                  </button>
                </div>
              </div>
              <pre data-slot="code-content">
                <code>{b.content}</code>
              </pre>
            </div>
          </Show>
        )}
      </For>
    </div>
  )
}
