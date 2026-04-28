/**
 * In-app notification center.
 *
 * One singleton store keeps a ring buffer of the last 50 notifications so
 * the user can scroll back through what the system did while they weren't
 * looking — sync results, host-gone events, license changes, etc. Other
 * modules push by calling `useNotifications().push({...})`; nothing else
 * needs to be wired.
 *
 * Notifications come in three severities. Critical ones surface as a
 * toast AND go into the drawer; info-level ones go straight into the
 * drawer. Persisted in localStorage so a reload doesn't blank the
 * history.
 */

import { batch, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"

export type NotificationLevel = "info" | "warning" | "error" | "success"

export interface AppNotification {
  id: string
  level: NotificationLevel
  title: string
  body?: string
  /** ms since epoch */
  createdAt: number
  /** has the user seen it (i.e. opened the drawer after it landed) */
  read: boolean
  /** optional click target — opens the route when the row is clicked */
  href?: string
}

const MAX_HISTORY = 50
const STORAGE_KEY = "client.notifications.v1"

function load(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AppNotification[]
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

function persist(list: AppNotification[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)))
  } catch {
    /* private mode / quota — non-fatal */
  }
}

let _push: ((n: Omit<AppNotification, "id" | "createdAt" | "read">) => void) | null = null

/**
 * Module-level push function for callers that don't sit inside a Solid
 * component (utilities, fetch helpers). Wires up the first time the
 * provider mounts. Falls through to a console.info before then.
 */
export function notify(n: Omit<AppNotification, "id" | "createdAt" | "read">): void {
  if (_push) return _push(n)
  console.info("[notify:pre-mount]", n.title, n.body ?? "")
}

export const { use: useNotifications, provider: NotificationsProvider } = createSimpleContext({
  name: "Notifications",
  init: () => {
    const [items, setItems] = createSignal<AppNotification[]>(load())
    const [open, setOpen] = createSignal(false)

    function push(input: Omit<AppNotification, "id" | "createdAt" | "read">): void {
      const n: AppNotification = {
        id: "n_" + Math.random().toString(36).slice(2, 12),
        createdAt: Date.now(),
        read: false,
        ...input,
      }
      batch(() => {
        const next = [n, ...items()].slice(0, MAX_HISTORY)
        setItems(next)
        persist(next)
      })
    }

    function markAllRead(): void {
      const next = items().map((n) => ({ ...n, read: true }))
      setItems(next)
      persist(next)
    }

    function clear(): void {
      setItems([])
      persist([])
    }

    function remove(id: string): void {
      const next = items().filter((n) => n.id !== id)
      setItems(next)
      persist(next)
    }

    const unread: Accessor<number> = () => items().filter((n) => !n.read).length

    onMount(() => {
      _push = push
      onCleanup(() => {
        if (_push === push) _push = null
      })
    })

    return {
      items,
      unread,
      open,
      setOpen,
      push,
      markAllRead,
      clear,
      remove,
    }
  },
})
