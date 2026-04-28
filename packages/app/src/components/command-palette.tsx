import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate } from "@solidjs/router"

/**
 * Cmd/Ctrl+K command palette.
 *
 * Two kinds of entries are supported:
 *   - "command": a static action (open settings, sign out, …) registered
 *     at module init time via the exported `registerCommand`. Modules
 *     that own their own behaviour just register themselves once and
 *     don't need to know about the palette internals.
 *   - "route": navigate to a URL.
 *
 * Fuzzy substring match on title + keywords; case-insensitive. Keyboard
 * nav with arrows + Enter, Esc to close.
 */

export interface PaletteCommand {
  id: string
  title: string
  /** Extra search tokens (synonyms). Lower-cased before matching. */
  keywords?: string[]
  /** Visual hint shown on the right (e.g. "Settings"). */
  group?: string
  /** Either run on selection, or navigate to href. */
  run?: () => void | Promise<void>
  href?: string
}

const _registry: PaletteCommand[] = []

export function registerCommand(cmd: PaletteCommand): void {
  // Replace if same id already registered (HMR friendly).
  const idx = _registry.findIndex((c) => c.id === cmd.id)
  if (idx >= 0) _registry[idx] = cmd
  else _registry.push(cmd)
}

function score(cmd: PaletteCommand, q: string): number {
  if (!q) return 0
  const hay = (cmd.title + " " + (cmd.keywords ?? []).join(" ")).toLowerCase()
  const needle = q.toLowerCase()
  if (hay.includes(needle)) return 100 - hay.indexOf(needle) // prefer matches near the start
  // Letter-by-letter subsequence fallback (very lenient, like fzf).
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i === needle.length) return 1
  }
  return -1
}

export function CommandPalette() {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const navigate = useNavigate()

  const matches = createMemo<PaletteCommand[]>(() => {
    const q = query().trim()
    if (!q) {
      // Empty query → show all commands grouped by group.
      return [..._registry].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? ""))
    }
    return _registry
      .map((c) => ({ c, s: score(c, q) }))
      .filter(({ s }) => s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(({ c }) => c)
  })

  function close() {
    setOpen(false)
    setQuery("")
    setActive(0)
  }

  function activate(cmd: PaletteCommand) {
    close()
    if (cmd.run) {
      try {
        void cmd.run()
      } catch (err) {
        console.warn("[palette]", cmd.id, err)
      }
    } else if (cmd.href) {
      navigate(cmd.href)
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
        setQuery("")
        setActive(0)
        return
      }
      if (!open()) return
      if (e.key === "Escape") {
        e.preventDefault()
        close()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActive((i) => Math.min(matches().length - 1, i + 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActive((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        const cmd = matches()[active()]
        if (cmd) activate(cmd)
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={open()}>
      <Portal>
        <div data-component="command-palette" onClick={(e) => {
          if ((e.target as HTMLElement).dataset.slot === "backdrop") close()
        }}>
          <div data-slot="backdrop" />
          <div data-slot="panel" role="dialog" aria-label="Command palette">
            <input
              autofocus
              type="text"
              placeholder="Search commands and routes…"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setActive(0)
              }}
            />
            <div data-slot="hint">↑↓ navigate · ↵ select · Esc close</div>
            <Show
              when={matches().length > 0}
              fallback={<div data-slot="empty">No commands match "{query()}".</div>}
            >
              <ul>
                <For each={matches()}>
                  {(cmd, i) => (
                    <li
                      data-active={i() === active()}
                      onMouseEnter={() => setActive(i())}
                      onClick={() => activate(cmd)}
                    >
                      <span data-slot="title">{cmd.title}</span>
                      <Show when={cmd.group}>
                        <span data-slot="group">{cmd.group}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

/** Pre-register the always-on built-in commands. */
export function registerBuiltinCommands(): void {
  registerCommand({
    id: "nav:home",
    title: "Go to Home",
    keywords: ["home", "start", "projects"],
    group: "Navigation",
    href: "/",
  })
  registerCommand({
    id: "nav:account",
    title: "Open Account dashboard",
    keywords: ["account", "profile", "license", "devices", "sync"],
    group: "Navigation",
    href: "/account",
  })
  registerCommand({
    id: "nav:security",
    title: "Open Security",
    keywords: ["security", "tools"],
    group: "Navigation",
    href: "/security",
  })
  registerCommand({
    id: "act:reload",
    title: "Reload window",
    keywords: ["reload", "refresh", "restart"],
    group: "Actions",
    run: () => window.location.reload(),
  })
  registerCommand({
    id: "act:notifications",
    title: "Open notifications",
    keywords: ["notifications", "alerts", "bell"],
    group: "Actions",
    run: () => {
      window.dispatchEvent(new CustomEvent("open-notifications"))
    },
  })
  registerCommand({
    id: "act:settings",
    title: "Open Settings",
    keywords: ["settings", "preferences", "config"],
    group: "Actions",
    run: () => {
      window.dispatchEvent(new CustomEvent("open-settings"))
    },
  })
}
