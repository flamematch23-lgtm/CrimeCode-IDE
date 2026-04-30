/**
 * bindPromptEditor — connect a Y.Text to the prompt contenteditable element.
 *
 * The prompt input ([data-component="prompt-input"]) is a rich contenteditable
 * that embeds pill elements for context items, @agents, and file references.
 * This binding syncs only the plain-text content (el.innerText); pill elements
 * are local-only and are not transferred via CRDT.
 *
 * Directionality:
 *   - LOCAL → Y.Text: fires on every "input" event (debounced by the browser).
 *   - Y.Text → LOCAL: fires on remote updates only (echoes filtered by origin).
 *     When a remote update arrives the contenteditable's innerText is replaced
 *     and the caret is moved to the nearest sensible position.
 *
 * Usage:
 *   const cleanup = bindPromptEditor(provider.doc.getText("draft"), el)
 *   // later:
 *   cleanup()
 */

import * as Y from "yjs"

type Cleanup = () => void

function getCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return 0
  // Walk the container and count characters before the caret.
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

function setCaretOffset(el: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  let remaining = offset
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? "").length
      if (remaining <= len) {
        try {
          const range = document.createRange()
          range.setStart(node, remaining)
          range.collapse(true)
          sel.removeAllRanges()
          sel.addRange(range)
        } catch {}
        return true
      }
      remaining -= len
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }
  walk(el)
}

export function bindPromptEditor(ytext: Y.Text, el: HTMLDivElement): Cleanup {
  const LOCAL = Symbol("prompt-crdt-local")
  let ignoreInput = false

  // ── LOCAL → Y.Text ──────────────────────────────────────────────────────
  function onInput() {
    if (ignoreInput) return
    // innerText includes line-break characters introduced by <br> and block
    // elements; strip the trailing newline browsers append.
    const text = (el.innerText ?? "").replace(/​/g, "").replace(/\n$/, "")
    const current = ytext.toString()
    if (text === current) return
    ytext.doc!.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, text)
    }, LOCAL)
  }

  // ── Y.Text → LOCAL ──────────────────────────────────────────────────────
  function onYChange(_ev: Y.YTextEvent, tx: Y.Transaction) {
    if (tx.origin === LOCAL) return // our own update — skip
    const text = ytext.toString()
    const current = (el.innerText ?? "").replace(/​/g, "").replace(/\n$/, "")
    if (text === current) return

    const offset = getCaretOffset(el)

    ignoreInput = true
    // Replace ONLY the first text node so pill elements (contenteditable=false
    // spans for @agents, files, etc.) are left untouched. If there's no text
    // node yet, fall back to a full innerText replacement.
    const firstText = findFirstTextNode(el)
    if (firstText) {
      firstText.textContent = text
    } else {
      el.innerText = text
    }
    ignoreInput = false

    // Restore caret to the closest sensible position.
    setCaretOffset(el, Math.min(offset, text.length))
  }

  el.addEventListener("input", onInput)
  ytext.observe(onYChange)

  return () => {
    el.removeEventListener("input", onInput)
    ytext.unobserve(onYChange)
  }
}

function findFirstTextNode(el: HTMLElement): Text | null {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) return child as Text
  }
  return null
}

/**
 * Locate the prompt contenteditable element in the current document, if
 * it exists and is attached. Returns null when navigated away from a
 * session (no prompt box visible).
 */
export function findPromptEl(): HTMLDivElement | null {
  return document.querySelector<HTMLDivElement>('[data-component="prompt-input"]')
}
