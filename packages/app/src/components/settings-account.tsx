import { Component, createMemo, createResource, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { useServer } from "@/context/server"
import { getAccountMe, type AccountMe } from "@/utils/account-client"

/**
 * "Account" tab inside the settings dialog. Pulls /account/me to show a
 * compact identity card (customer id, telegram, status, member-since) and
 * funnels the user toward the full dashboard at /account for the heavier
 * actions (device list, cloud-sync stats, sign-out-everywhere).
 *
 * The full dashboard owns the destructive operations on purpose — keeping
 * them out of a small dialog tab avoids accidental clicks while a user is
 * "just changing a setting".
 */
export const SettingsAccount: Component = () => {
  const server = useServer()
  const navigate = useNavigate()

  const httpCreds = createMemo(() => {
    const c = server.current
    if (!c || !("http" in c)) return null
    return { url: c.http.url, username: c.http.username, password: c.http.password }
  })

  const [me] = createResource(httpCreds, async (creds) => {
    if (!creds) return null
    try {
      return await getAccountMe(creds)
    } catch {
      // The /account endpoints require a Bearer session. On a Basic-auth
      // self-hosted sidecar this resource just resolves to null, and we
      // render the "not signed in" branch.
      return null
    }
  })

  function openDashboard() {
    navigate("/account")
    // The settings dialog closes itself when the route changes — no extra
    // wiring needed beyond the navigate() call.
  }

  return (
    <div class="flex flex-col gap-6 p-4">
      <header class="flex flex-col gap-1">
        <h2 class="text-16-semibold text-text-strong">Account</h2>
        <p class="text-12-regular text-text-subtle">
          Identity and cross-device sync for your CrimeCode account.
        </p>
      </header>

      <Show
        when={me()}
        fallback={<NotSignedIn loading={me.loading} />}
      >
        {(meRes) => <IdentityCard me={meRes()} onOpenDashboard={openDashboard} />}
      </Show>
    </div>
  )
}

function NotSignedIn(props: { loading: boolean }) {
  return (
    <div class="rounded-md border border-border-base p-4 text-12-regular text-text-subtle">
      <Show when={!props.loading} fallback={<span>Loading…</span>}>
        You're not signed in to a CrimeCode account on this server. Account
        features are available after a Telegram or username sign-in.
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
