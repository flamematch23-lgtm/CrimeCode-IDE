import { Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServer } from "@/context/server"
import { getAccountMe, getSyncMe, hasAccountSession } from "@/utils/account-client"

/**
 * Persistent footer strip with at-a-glance system health: connectivity,
 * cloud sync freshness, license state, and (when in a team) team presence.
 * Click any indicator → opens the relevant management surface.
 *
 * Polls every 30s for sync stats + license; relies on the browser
 * `online`/`offline` events for connectivity (no busy-loop).
 */
export function StatusBarLive() {
  const server = useServer()
  const navigate = useNavigate()

  const [online, setOnline] = createSignal(typeof navigator !== "undefined" ? navigator.onLine : true)
  const [tick, setTick] = createSignal(0)
  const signedIn = createMemo(() => hasAccountSession())

  onMount(() => {
    const onUp = () => setOnline(true)
    const onDown = () => setOnline(false)
    window.addEventListener("online", onUp)
    window.addEventListener("offline", onDown)
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    onCleanup(() => {
      window.removeEventListener("online", onUp)
      window.removeEventListener("offline", onDown)
      clearInterval(t)
    })
  })

  const [me] = createResource(
    () => [signedIn(), tick()] as const,
    async ([yes]) => (yes ? await getAccountMe().catch(() => null) : null),
  )
  const [sync] = createResource(
    () => [signedIn(), tick()] as const,
    async ([yes]) => (yes ? await getSyncMe().catch(() => null) : null),
  )

  // Local server live-share / team presence — read from localStorage so we
  // don't add yet another network call. The workspace switcher writes
  // these keys; live-cursors reads them too.
  const teamId = createMemo(() => {
    try {
      const raw = localStorage.getItem("client.active-workspace")
      if (!raw) return null
      const p = JSON.parse(raw)
      return p?.kind === "team" ? p.id : null
    } catch {
      return null
    }
  })

  const syncFresh = createMemo(() => {
    const s = sync()
    if (!s?.lastPushedAt) return null
    const ago = Date.now() - s.lastPushedAt
    if (ago < 60_000) return "now"
    if (ago < 60 * 60_000) return `${Math.round(ago / 60_000)}m`
    return `${Math.round(ago / (60 * 60_000))}h`
  })

  return (
    <footer data-component="status-bar-live" data-online={online() ? "true" : "false"}>
      <div data-slot="net" title={online() ? "Online" : "Offline"} data-state={online() ? "online" : "offline"}>
        <span data-slot="dot" />
        <span data-slot="label">{online() ? "Online" : "Offline"}</span>
      </div>

      <Show when={signedIn()}>
        <button
          data-slot="sync"
          title={sync()?.lastPushedAt ? `Last sync ${syncFresh()} ago` : "Cloud sync — no events yet"}
          onClick={() => navigate("/account")}
        >
          <span>☁</span>
          <span data-slot="label">{sync()?.lastPushedAt ? `Synced ${syncFresh()} ago` : "Sync ready"}</span>
        </button>

        <button
          data-slot="license"
          title="Click to open account dashboard"
          onClick={() => navigate("/account")}
          data-status={me()?.status ?? "unknown"}
        >
          <span>🎟</span>
          <span data-slot="label">{me()?.status ?? "—"}</span>
        </button>
      </Show>

      <Show when={teamId()}>
        <button data-slot="team" title="Open team workspace" onClick={() => {
          // The workspace switcher button is in the topbar — clicking the
          // status indicator just nudges the user there with a flash.
          window.dispatchEvent(new CustomEvent("workspace-switcher-flash"))
        }}>
          <span>👥</span>
          <span data-slot="label">Team</span>
        </button>
      </Show>

      <Show when={!signedIn()}>
        <span data-slot="hint">Not signed in</span>
      </Show>
    </footer>
  )
}
