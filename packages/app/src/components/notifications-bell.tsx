import { For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useNotifications, type AppNotification, type NotificationLevel } from "@/context/notifications"

/**
 * Bell icon that lives in the topbar. Click → open a fixed drawer
 * docked to the top-right showing the last 50 notifications, with
 * mark-all-read and clear-all controls. Unread count is rendered as a
 * badge on the bell.
 */
export function NotificationsBell() {
  const n = useNotifications()
  return (
    <>
      <button
        data-component="notifications-bell"
        aria-label={`Notifications (${n.unread()} unread)`}
        onClick={() => {
          n.setOpen(!n.open())
          if (!n.open()) {
            // Opening the drawer counts as "seen" — flip read state on close
            // would be too aggressive; flip it on open so the badge
            // disappears immediately.
            window.setTimeout(() => n.markAllRead(), 1500)
          }
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path
            d="M9 2C6.5 2 4.5 4 4.5 6.5V9.5L3 12H15L13.5 9.5V6.5C13.5 4 11.5 2 9 2Z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
            fill="none"
          />
          <path d="M7 13.5C7 14.6 7.9 15.5 9 15.5S11 14.6 11 13.5" stroke="currentColor" stroke-width="1.3" />
        </svg>
        <Show when={n.unread() > 0}>
          <span data-slot="badge">{n.unread() > 99 ? "99+" : n.unread()}</span>
        </Show>
      </button>

      <Show when={n.open()}>
        <Portal>
          <div data-component="notifications-drawer">
            <div data-slot="backdrop" onClick={() => n.setOpen(false)} />
            <aside data-slot="panel" role="dialog" aria-label="Notifications">
              <header>
                <h2>Notifications</h2>
                <div data-slot="actions">
                  <button onClick={() => n.markAllRead()} disabled={n.unread() === 0}>
                    Mark all read
                  </button>
                  <button onClick={() => n.clear()} disabled={n.items().length === 0}>
                    Clear
                  </button>
                  <button data-slot="close" onClick={() => n.setOpen(false)} aria-label="Close">
                    ×
                  </button>
                </div>
              </header>
              <Show when={n.items().length > 0} fallback={<EmptyState />}>
                <ul>
                  <For each={n.items()}>
                    {(item) => (
                      <li data-level={item.level} data-read={item.read} onClick={() => maybeNavigate(item)}>
                        <span data-slot="icon">{iconFor(item.level)}</span>
                        <div data-slot="body">
                          <div data-slot="title">{item.title}</div>
                          <Show when={item.body}>
                            <div data-slot="text">{item.body}</div>
                          </Show>
                          <div data-slot="time">{relTime(item.createdAt)}</div>
                        </div>
                        <button
                          data-slot="dismiss"
                          aria-label="Dismiss"
                          onClick={(e) => {
                            e.stopPropagation()
                            n.remove(item.id)
                          }}
                        >
                          ×
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </aside>
          </div>
        </Portal>
      </Show>
    </>
  )
}

function maybeNavigate(item: AppNotification): void {
  if (!item.href) return
  // Use the same router the rest of the app uses — but to avoid a hard
  // dependency on @solidjs/router from this leaf component, we just
  // dispatch to window.location for cross-route hrefs.
  window.location.href = item.href
}

function EmptyState() {
  return (
    <div data-slot="empty">
      <p>No notifications yet.</p>
      <p>Sync events, login activity and license changes show up here.</p>
    </div>
  )
}

function iconFor(level: NotificationLevel): string {
  switch (level) {
    case "success":
      return "✓"
    case "warning":
      return "⚠"
    case "error":
      return "✕"
    default:
      return "ⓘ"
  }
}

function relTime(ts: number): string {
  const ms = Date.now() - ts
  if (ms < 0) return "now"
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} h ago`
  const d = Math.round(hr / 24)
  return `${d} day${d === 1 ? "" : "s"} ago`
}
