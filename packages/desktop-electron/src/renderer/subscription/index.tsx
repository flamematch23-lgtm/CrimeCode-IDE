import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { SubscriptionModal } from "./subscription-modal"
import { AdminPanel } from "./admin-panel"
import { TrialBanner } from "./trial-banner"

export function SubscriptionOverlay() {
  const [sub, setSub] = createSignal(false)
  const [showAdminPanel, setShowAdminPanel] = createSignal(false)

  onMount(() => {
    const unsub = window.api.onMenuCommand((id) => {
      if (id === "open-subscription") setSub(true)
      if (id === "open-admin-panel") setShowAdminPanel(true)
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
    </>
  )
}
