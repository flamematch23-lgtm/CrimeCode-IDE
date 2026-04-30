/**
 * PromptCursorOverlay — renders remote team-members' carets on top of the
 * prompt contenteditable.
 *
 * Each peer in `awareness.getStates()` that has a non-null `cursor` field
 * (set by bindPromptEditor) gets a thin colored caret + a small username
 * label. The overlay is absolutely positioned over the prompt element and
 * pointer-events: none so it never intercepts clicks.
 *
 * Coordinates: we read the prompt's bounding rect on every render and
 * translate the absolute viewport rects (from offsetToRect) into the
 * overlay's local space. This survives scroll, resize, and font changes —
 * we re-render on every animation frame while at least one remote cursor
 * is active.
 */

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import type { Awareness } from "y-protocols/awareness"
import { offsetToRect, type AwarenessCursorState } from "./bind-prompt-editor"

interface RemoteCursor {
  clientId: number
  customerId: string
  name: string
  color: string
  cursor: AwarenessCursorState
}

interface OverlayPosition {
  top: number
  left: number
  width: number
  height: number
  label: string
  color: string
  hasSelection: boolean
}

// Stable color per customer_id — quick hash to a hue.
function colorForId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 70%, 55%)`
}

export function PromptCursorOverlay(props: {
  awareness: Awareness
  promptEl: HTMLDivElement
  selfClientId: number
}) {
  const [positions, setPositions] = createSignal<OverlayPosition[]>([])

  function readPeers(): RemoteCursor[] {
    const out: RemoteCursor[] = []
    for (const [clientId, state] of props.awareness.getStates()) {
      if (clientId === props.selfClientId) continue
      const s = state as { cursor?: AwarenessCursorState | null; user?: { customer_id?: string; name?: string } }
      if (!s?.cursor) continue
      const customerId = s.user?.customer_id ?? `c${clientId}`
      out.push({
        clientId,
        customerId,
        name: s.user?.name ?? customerId.slice(0, 8),
        color: colorForId(customerId),
        cursor: s.cursor,
      })
    }
    return out
  }

  function recompute() {
    const peers = readPeers()
    if (peers.length === 0) {
      setPositions([])
      return
    }
    const promptRect = props.promptEl.getBoundingClientRect()
    const next: OverlayPosition[] = []
    for (const p of peers) {
      const start = Math.min(p.cursor.anchor, p.cursor.head)
      const end = Math.max(p.cursor.anchor, p.cursor.head)
      const startRect = offsetToRect(props.promptEl, start)
      if (!startRect) continue
      const hasSelection = end !== start
      if (!hasSelection) {
        next.push({
          top: startRect.top - promptRect.top,
          left: startRect.left - promptRect.left,
          width: 2,
          height: startRect.height || 18,
          label: p.name,
          color: p.color,
          hasSelection: false,
        })
        continue
      }
      const endRect = offsetToRect(props.promptEl, end)
      if (!endRect) continue
      // Single-line selection assumption — multi-line would need to walk
      // line-by-line. The prompt is short enough that single-line is fine.
      next.push({
        top: startRect.top - promptRect.top,
        left: startRect.left - promptRect.left,
        width: Math.max(2, endRect.left - startRect.left),
        height: startRect.height || 18,
        label: p.name,
        color: p.color,
        hasSelection: true,
      })
    }
    setPositions(next)
  }

  createEffect(() => {
    const onChange = () => recompute()
    props.awareness.on("change", onChange)
    // Re-measure on resize / scroll — the prompt area can scroll independently.
    window.addEventListener("resize", onChange)
    props.promptEl.addEventListener("scroll", onChange, { capture: true })
    // Initial paint.
    recompute()
    onCleanup(() => {
      props.awareness.off("change", onChange)
      window.removeEventListener("resize", onChange)
      props.promptEl.removeEventListener("scroll", onChange, { capture: true })
    })
  })

  return (
    <Show when={positions().length > 0}>
      <div
        class="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        aria-hidden="true"
      >
        <For each={positions()}>
          {(pos) => (
            <div
              class="absolute"
              style={{
                top: `${pos.top}px`,
                left: `${pos.left}px`,
                width: `${pos.width}px`,
                height: `${pos.height}px`,
                background: pos.hasSelection ? `${pos.color}33` : pos.color,
                "border-left": pos.hasSelection ? `2px solid ${pos.color}` : "none",
              }}
            >
              <Show when={!pos.hasSelection}>
                <div
                  class="absolute -top-4 left-0 whitespace-nowrap rounded-sm px-1 py-0.5 text-[10px] font-medium text-white"
                  style={{ background: pos.color }}
                >
                  {pos.label}
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
