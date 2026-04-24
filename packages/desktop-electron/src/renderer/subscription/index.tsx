import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { SubscriptionModal } from "./subscription-modal"
import { AdminPanel } from "./admin-panel"
import { AccountModal } from "./account-modal"
import { TrialBanner } from "./trial-banner"
import { recordProjectOpen, schedulePush } from "./sync-manager"
import { LiveCursors, TeamPresenceBadge } from "../teams"
import { writeWebSession } from "@opencode-ai/app/utils/teams-client"

export function SubscriptionOverlay() {
  const [sub, setSub] = createSignal(false)
  const [showAdminPanel, setShowAdminPanel] = createSignal(false)
  const [showAccount, setShowAccount] = createSignal(false)

  onMount(() => {
    // Mirror the electron-store session into localStorage so the shared
    // teams client (EventSource-based SSE) can reach it the same way the
    // web build does. Runs once at startup.
    void window.api.account
      .get()
      .then((s) =>
        writeWebSession(
          s
            ? {
                token: s.token,
                customer_id: s.customer_id,
                telegram_user_id: s.telegram_user_id,
                expires_at: s.expires_at,
              }
            : null,
        ),
      )
      .catch(() => undefined)
    const unsub = window.api.onMenuCommand((id) => {
      if (id === "open-subscription") setSub(true)
      if (id === "open-admin-panel") setShowAdminPanel(true)
      if (id === "account.open") setShowAccount(true)
      if (id === "project.new") void handleProjectNew()
    })
    onCleanup(unsub)
  })

  return (
    <>
      <TrialBanner onUpgrade={() => setSub(true)} />
      <SubscriptionModal open={sub()} onClose={() => setSub(false)} />
      <Show when={showAdminPanel()}>
        <AdminPanel onClose={() => setShowAdminPanel(false)} />
      </Show>
      <Show when={showAccount()}>
        <AccountModal onClose={() => setShowAccount(false)} />
      </Show>
      {/* WorkspaceSwitcher is now mounted directly inside the titlebar
          (see packages/app/src/components/titlebar.tsx) so the dock here
          only carries the smaller team-presence pill. */}
      <div data-component="workspace-dock">
        <TeamPresenceBadge />
      </div>
      <LiveCursors />
    </>
  )
}

async function handleProjectNew() {
  try {
    const result = await window.api.project.create()
    if (!result?.directory) return
    // Record in local + debounced cloud push (only fires if signed in).
    recordProjectOpen(result.directory)
    schedulePush()
    // Hand the directory off to the existing "open project" handler so the
    // app jumps into the same first-run flow it already knows.
    window.location.hash = `#open?directory=${encodeURIComponent(result.directory)}`
  } catch (err) {
    console.error("project.new failed", err)
  }
}
