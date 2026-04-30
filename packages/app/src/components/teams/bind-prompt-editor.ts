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
import type { Awareness } from "y-protocols/awareness"

type Cleanup = () => void

/**
 * Shape of the cursor field we put into Awareness state. Other clients read
 * this to draw remote carets/selections in the prompt overlay. `anchor` and
 * `head` are character offsets into the plain-text view of Y.Text.
 *   - anchor === head → caret only
 *   - anchor !== head → selection range
 */
export interface AwarenessCursorState {
  anchor: number
  head: number
}

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

/**
 * Read the current selection inside `el` as plain-text offsets. Returns null
 * when nothing is selected or the selection is outside the element.
 */
function getSelectionOffsets(el: HTMLElement): AwarenessCursorState | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null
  const startRange = range.cloneRange()
  startRange.selectNodeContents(el)
  startRange.setEnd(range.startContainer, range.startOffset)
  const endRange = range.cloneRange()
  endRange.selectNodeContents(el)
  endRange.setEnd(range.endContainer, range.endOffset)
  // Direction: if anchor === backward, swap; for our purposes treat them as
  // numbers — `anchor` = where the user started selecting, `head` = caret.
  const anchor = startRange.toString().length
  const head = endRange.toString().length
  return { anchor, head }
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

export function bindPromptEditor(
  ytext: Y.Text,
  el: HTMLDivElement,
  awareness?: Awareness,
): Cleanup {
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
    publishCursor()
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

  // ── LOCAL caret/selection → Awareness ───────────────────────────────────
  function publishCursor() {
    if (!awareness) return
    const cursor = getSelectionOffsets(el)
    awareness.setLocalStateField("cursor", cursor)
  }

  el.addEventListener("input", onInput)
  // selectionchange fires globally on document — filter to our element.
  function onSelectionChange() {
    if (document.activeElement !== el) return
    publishCursor()
  }
  document.addEventListener("selectionchange", onSelectionChange)
  function onBlur() {
    if (!awareness) return
    awareness.setLocalStateField("cursor", null)
  }
  el.addEventListener("blur", onBlur)

  ytext.observe(onYChange)

  return () => {
    el.removeEventListener("input", onInput)
    el.removeEventListener("blur", onBlur)
    document.removeEventListener("selectionchange", onSelectionChange)
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

/**
 * Convert a plain-text character offset into a pixel rect inside `el`.
 * Returns null if the offset is out of range or the DOM has no text yet.
 *
 * Used by the remote-cursor overlay to position other peers' carets — we
 * walk into the right text node, build a Range at that exact char, and
 * read its bounding client rect. Pixel coordinates are relative to the
 * viewport (use el.getBoundingClientRect() to convert to local space).
 */
export function offsetToRect(el: HTMLElement, offset: number): DOMRect | null {
  let remaining = offset
  let target: { node: Text; pos: number } | null = null
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? "").length
      if (remaining <= len) {
        target = { node: node as Text, pos: remaining }
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
  if (!target) {
    // Past the end — caret at the very end of the editor.
    const r = el.getBoundingClientRect()
    return new DOMRect(r.right - 1, r.top, 1, r.height)
  }
  try {
    const range = document.createRange()
    range.setStart((target as { node: Text; pos: number }).node, (target as { node: Text; pos: number }).pos)
    range.setEnd((target as { node: Text; pos: number }).node, (target as { node: Text; pos: number }).pos)
    const rects = range.getClientRects()
    if (rects.length === 0) return range.getBoundingClientRect()
    return rects[0]
  } catch {
    return null
  }
}
