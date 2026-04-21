import { createSignal, onCleanup, onMount } from "solid-js"
import { SubscriptionModal } from "./subscription-modal"
import { AdminModal } from "./admin-modal"
import { TrialBanner } from "./trial-banner"

export function SubscriptionOverlay() {
  const [sub, setSub] = createSignal(false)
  const [admin, setAdmin] = createSignal(false)

  onMount(() => {
    const unsub = window.api.onMenuCommand((id) => {
      if (id === "open-subscription") setSub(true)
      if (id === "open-admin-panel") setAdmin(true)
    })
    onCleanup(unsub)
  })

  return (
    <>
      <TrialBanner onUpgrade={() => setSub(true)} />
      <SubscriptionModal open={sub()} onClose={() => setSub(false)} />
      <AdminModal open={admin()} onClose={() => setAdmin(false)} />
    </>
  )
}
