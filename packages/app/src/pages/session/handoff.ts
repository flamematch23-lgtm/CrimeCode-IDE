import type { SelectedLineRange } from "@/context/file"
import type { Prompt } from "@/context/prompt"

type HandoffSession = {
  prompt: string
  files: Record<string, SelectedLineRange | null>
  /**
   * Prompt parts to apply to the composer the first time it becomes ready.
   * Consumed (set back to undefined) by the composer after applying — so
   * deep-links like Burp Workspace can pre-fill `@pentester` + a body
   * without overwriting whatever the user is currently typing on revisits.
   */
  pendingPrompt?: Prompt
}

const MAX = 40

const store = {
  session: new Map<string, HandoffSession>(),
  terminal: new Map<string, string[]>(),
}

const touch = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX) {
    const first = map.keys().next().value
    if (first === undefined) return
    map.delete(first)
  }
}

export const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
  const prev = store.session.get(key) ?? { prompt: "", files: {} }
  touch(store.session, key, { ...prev, ...patch })
}

export const getSessionHandoff = (key: string) => store.session.get(key)

export const setTerminalHandoff = (key: string, value: string[]) => {
  touch(store.terminal, key, value)
}

export const getTerminalHandoff = (key: string) => store.terminal.get(key)
