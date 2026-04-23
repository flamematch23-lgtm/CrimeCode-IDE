/**
 * Focus-trap utility for modal dialogs.
 *
 * Tab/Shift+Tab cycle within the element, Escape closes, initial focus is
 * moved to the first focusable child (or a marked [data-autofocus] element).
 * Returns an unsubscribe that restores the previously-focused element.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("data-focus-trap-ignore") && el.offsetParent !== null,
  )
}

export interface FocusTrapHandle {
  release: () => void
}

export function installFocusTrap(
  root: HTMLElement,
  onEscape?: () => void,
): FocusTrapHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null

  // Initial focus: respect [data-autofocus] then fall back to the first
  // focusable child, then the root itself (with tabindex=-1).
  const preferred = root.querySelector<HTMLElement>("[data-autofocus]")
  const first = preferred ?? focusablesIn(root)[0] ?? root
  if (first === root && !root.hasAttribute("tabindex")) root.tabIndex = -1
  first.focus()

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation()
      onEscape?.()
      return
    }
    if (e.key !== "Tab") return
    const focusables = focusablesIn(root)
    if (focusables.length === 0) {
      e.preventDefault()
      return
    }
    const active = document.activeElement as HTMLElement | null
    const idx = active ? focusables.indexOf(active) : -1
    if (e.shiftKey) {
      if (idx <= 0) {
        e.preventDefault()
        focusables[focusables.length - 1].focus()
      }
    } else {
      if (idx === -1 || idx === focusables.length - 1) {
        e.preventDefault()
        focusables[0].focus()
      }
    }
  }

  root.addEventListener("keydown", onKeyDown)

  return {
    release() {
      root.removeEventListener("keydown", onKeyDown)
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try {
          previouslyFocused.focus()
        } catch {
          // previously-focused node might be gone (e.g. disposed)
        }
      }
    },
  }
}
