import { Component, createResource, createSignal, onMount, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { getAccountMe, hasAccountSession, type AccountMe } from "@/utils/account-client"

/**
 * "Account" tab inside the settings dialog. Talks directly to the cloud
 * API — the customer record lives there, not on the local Electron
 * sidecar. The previous version of this tab read `useServer().current`
 * which on desktop after a Telegram login is still the local sidecar
 * (Basic auth) — the sidecar can't identify the customer from Basic
 * auth, so /account/me 401'd and the tab erroneously showed
 * "not signed in" even when the workspace switcher right next to it
 * displayed the user's customer id correctly.
 */
export const SettingsAccount: Component = () => {
  const navigate = useNavigate()
  // Reactive flag so the tab re-renders when the user logs in / out
  // without us having to wire a per-tab subscription. We poll storage on
  // a 1.5s timer (cheap — read of a single localStorage key) which is
  // plenty for a UI surface that only opens manually.
  const [signedIn, setSignedIn] = createSignal(hasAccountSession())
  onMount(() => {
    const t = setInterval(() => setSignedIn(hasAccountSession()), 1500)
    onCleanup(() => clearInterval(t))
  })

  const [me] = createResource(signedIn, async (yes) => {
    if (!yes) return null
    try {
      return await getAccountMe()
    } catch {
      // Bearer rejected (expired? revoked?) — treat as not signed in for
      // the UI; the dashboard route will surface the actual error.
      return null
    }
  })

  return (
    <div class="flex flex-col gap-6 p-4">
      <header class="flex flex-col gap-1">
        <h2 class="text-16-semibold text-text-strong">Account</h2>
        <p class="text-12-regular text-text-subtle">
          Identity and cross-device sync for your CrimeCode account.
        </p>
      </header>

      <Show
        when={signedIn() && me()}
        fallback={<NotSignedIn signedIn={signedIn()} loading={me.loading} />}
      >
        {(meRes) => <IdentityCard me={meRes()} onOpenDashboard={() => navigate("/account")} />}
      </Show>
    </div>
  )
}

function NotSignedIn(props: { signedIn: boolean; loading: boolean }) {
  return (
    <div class="rounded-md border border-border-base p-4 text-12-regular text-text-subtle">
      <Show
        when={!props.loading}
        fallback={<span>Loading…</span>}
      >
        <Show
          when={props.signedIn}
          fallback={
            <>
              You're not signed in to a CrimeCode account. Use the workspace
              switcher in the top-right to sign in with Telegram or your
              username — your account will then appear here.
            </>
          }
        >
          We couldn't load your account info just now. The session may have
          expired — try signing in again from the workspace switcher.
        </Show>
      </Show>
    </div>
  )
}

function IdentityCard(props: { me: AccountMe; onOpenDashboard: () => void }) {
  const created = new Date(props.me.created_at * 1000).toLocaleDateString()
  const statusColor =
    props.me.status === "approved"
      ? "text-text-success"
      : props.me.status === "rejected"
        ? "text-text-error"
        : "text-text-warning"

  return (
    <div class="flex flex-col gap-4">
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded-md border border-border-base bg-surface-raised-base p-4 text-12-regular">
        <Row label="Customer ID">
          <code class="font-mono text-text-strong">{props.me.customer_id}</code>
        </Row>
        <Show when={props.me.telegram}>
          <Row label="Telegram">
            <span class="text-text-strong">@{props.me.telegram}</span>
          </Row>
        </Show>
        <Show when={props.me.email}>
          <Row label="Email">
            <span class="text-text-strong">{props.me.email}</span>
          </Row>
        </Show>
        <Row label="Status">
          <span class={statusColor}>{props.me.status}</span>
        </Row>
        <Row label="Member since">
          <span class="text-text-base">{created}</span>
        </Row>
      </dl>

      <div class="flex flex-col gap-2">
        <Button onClick={() => props.onOpenDashboard()}>Open full dashboard</Button>
        <p class="text-11-regular text-text-subtle">
          See active devices, cloud sync stats, and sign out of every device.
        </p>
      </div>
    </div>
  )
}

function Row(props: { label: string; children: any }) {
  return (
    <>
      <dt class="text-text-subtle">{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  )
}
