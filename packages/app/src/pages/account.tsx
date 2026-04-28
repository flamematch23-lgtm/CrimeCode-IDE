import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useServer } from "@/context/server"
import {
  getAccountMe,
  getAccountDevices,
  getSyncMe,
  hasAccountSession,
  revokeDevice,
  logoutAllDevices,
  triggerSyncNow,
  type AccountDevice,
  type AccountMe,
  type SyncMe,
} from "@/utils/account-client"
import { clearCredentials } from "@/pages/auth-gate"
import { writeWebSession } from "@/utils/teams-client"

/**
 * Customer dashboard. Identity and devices come from the central API
 * server (api.crimecode.cc) since the customer record + auth_sessions
 * table live there — the local sidecar can't speak Bearer for the
 * cloud's HMAC-signed JWTs. Sync-now, on the other hand, runs the
 * push/pull on the LOCAL CloudClient (because that's what holds the
 * unsynced events), so its credentials come from `useServer().current`
 * — i.e. whatever the user is locally pointed at.
 */
export default function AccountPage() {
  const server = useServer()
  const navigate = useNavigate()

  const localCreds = createMemo(() => {
    const c = server.current
    if (!c || !("http" in c)) return null
    return { url: c.http.url, username: c.http.username, password: c.http.password }
  })

  const [signedIn] = createSignal(hasAccountSession())

  const [me, meActions] = createResource(signedIn, async (yes) => {
    if (!yes) return null
    return getAccountMe()
  })

  const [devices, devicesActions] = createResource(signedIn, async (yes) => {
    if (!yes) return { devices: [] as AccountDevice[] }
    return getAccountDevices()
  })

  const [sync, syncActions] = createResource(signedIn, async (yes) => {
    if (!yes) return null
    try {
      return await getSyncMe()
    } catch {
      return null
    }
  })

  const [busy, setBusy] = createSignal<string | null>(null)
  const [toast, setToast] = createSignal<string | null>(null)

  function flash(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 4000)
  }

  async function onRevokeDevice(sid: string) {
    setBusy("revoke:" + sid)
    try {
      await revokeDevice(sid)
      devicesActions.refetch()
      flash("Device signed out.")
    } catch (err) {
      flash("Revoke failed: " + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(null)
    }
  }

  async function onLogoutAll() {
    if (!window.confirm("Sign out every device for this account, including this one?")) return
    setBusy("logout-all")
    try {
      const r = await logoutAllDevices()
      flash(`Signed out ${r.revoked} device${r.revoked === 1 ? "" : "s"}.`)
      // Our own session was just revoked — drop both creds and the
      // web session and bounce to login.
      writeWebSession(null)
      clearCredentials()
      navigate("/", { replace: true })
      window.location.reload()
    } catch (err) {
      flash("Logout failed: " + (err instanceof Error ? err.message : String(err)))
      setBusy(null)
    }
  }

  async function onSyncNow() {
    const creds = localCreds()
    if (!creds) {
      flash("No local server connected — sync-now needs the local sidecar.")
      return
    }
    setBusy("sync-now")
    try {
      const r = await triggerSyncNow(creds)
      flash(
        r.ok
          ? `Sync OK — pushed ${r.pushed}, pulled ${r.pulled}.`
          : "Sync skipped: " + (r.error ?? "not configured"),
      )
      syncActions.refetch()
    } catch (err) {
      flash("Sync failed: " + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div class="size-full overflow-y-auto bg-background-base">
      <div class="mx-auto max-w-2xl px-6 py-8">
        <div class="flex items-center justify-between mb-8">
          <h1 class="text-22-semibold text-text-strong">Account</h1>
          <Button variant="secondary" onClick={() => navigate("/")}>
            ← Back
          </Button>
        </div>

        <Show when={!signedIn()}>
          <div class="rounded-lg border border-border-base bg-surface-raised-base p-6 text-center">
            <p class="text-14-medium text-text-strong mb-2">Not signed in</p>
            <p class="text-12-regular text-text-subtle">
              Use the workspace switcher in the top-right to sign in with Telegram
              or your username, then come back here.
            </p>
          </div>
        </Show>

        <Show when={signedIn()}>
          {/* ───────── Identity ───────── */}
          <Section title="Identity" onRefresh={() => meActions.refetch()} loading={me.loading}>
            <Show when={me()} fallback={<Empty>Loading…</Empty>}>
              {(meRes) => <IdentityCard me={meRes()} />}
            </Show>
          </Section>

          {/* ───────── Devices ───────── */}
          <Section
            title="Active devices"
            onRefresh={() => devicesActions.refetch()}
            loading={devices.loading}
            right={
              <Button variant="primary" disabled={busy() === "logout-all"} onClick={onLogoutAll}>
                {busy() === "logout-all" ? "Signing out…" : "Sign out everywhere"}
              </Button>
            }
          >
            <Show
              when={(devices()?.devices ?? []).filter((d) => d.active).length > 0}
              fallback={<Empty>No active devices.</Empty>}
            >
              <ul class="divide-y divide-border-base">
                <For each={(devices()?.devices ?? []).filter((d) => d.active)}>
                  {(d) => (
                    <DeviceRow
                      device={d}
                      busy={busy() === "revoke:" + d.id}
                      onRevoke={() => onRevokeDevice(d.id)}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </Section>

          {/* ───────── Cloud sync ───────── */}
          <Section
            title="Cloud sync"
            onRefresh={() => syncActions.refetch()}
            loading={sync.loading}
            right={
              <Button variant="secondary" disabled={busy() === "sync-now"} onClick={onSyncNow}>
                {busy() === "sync-now" ? "Syncing…" : "Sync now"}
              </Button>
            }
          >
            <Show when={sync()} fallback={<Empty>No cloud-sync data yet for this account.</Empty>}>
              {(s) => <SyncCard stats={s()} />}
            </Show>
          </Section>
        </Show>
      </div>

      <Show when={toast()}>
        <div class="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-md bg-surface-raised-base text-text-strong shadow-lg text-12-medium">
          {toast()}
        </div>
      </Show>
    </div>
  )
}

function Section(props: {
  title: string
  children: any
  onRefresh: () => void
  loading: boolean
  right?: any
}) {
  return (
    <section class="mb-8">
      <header class="flex items-center justify-between mb-3">
        <h2 class="text-16-semibold text-text-strong">{props.title}</h2>
        <div class="flex items-center gap-2">
          {props.right}
          <button
            class="size-7 inline-flex items-center justify-center rounded hover:bg-surface-raised-base-hover text-icon-subtle disabled:opacity-50"
            onClick={() => props.onRefresh()}
            disabled={props.loading}
            title="Refresh"
          >
            <Icon name={props.loading ? "dash" : "arrow-down-to-line"} />
          </button>
        </div>
      </header>
      <div class="rounded-lg border border-border-base bg-surface-raised-base">{props.children}</div>
    </section>
  )
}

function Empty(props: { children: any }) {
  return <div class="px-4 py-6 text-12-regular text-text-subtle text-center">{props.children}</div>
}

function IdentityCard(props: { me: AccountMe }) {
  const created = new Date(props.me.created_at * 1000).toLocaleString()
  const approved = props.me.approved_at ? new Date(props.me.approved_at * 1000).toLocaleString() : null
  return (
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 px-4 py-4 text-12-regular">
      <Row label="Customer ID">
        <code class="font-mono text-text-strong">{props.me.customer_id}</code>
      </Row>
      <Row label="Telegram">
        {props.me.telegram ? (
          <span class="text-text-strong">@{props.me.telegram}</span>
        ) : (
          <span class="text-text-subtle">—</span>
        )}
      </Row>
      <Show when={props.me.telegram_user_id != null}>
        <Row label="Telegram ID">
          <code class="font-mono text-text-base">{props.me.telegram_user_id}</code>
        </Row>
      </Show>
      <Row label="Email">
        {props.me.email ? (
          <span class="text-text-strong">{props.me.email}</span>
        ) : (
          <span class="text-text-subtle">—</span>
        )}
      </Row>
      <Row label="Status">
        <span
          class={
            props.me.status === "approved"
              ? "text-text-success"
              : props.me.status === "rejected"
                ? "text-text-error"
                : "text-text-warning"
          }
        >
          {props.me.status}
        </span>
        <Show when={props.me.rejected_reason}>
          <span class="text-text-subtle"> — {props.me.rejected_reason}</span>
        </Show>
      </Row>
      <Row label="Member since">
        <span class="text-text-base">{created}</span>
      </Row>
      <Show when={approved}>
        <Row label="Approved">
          <span class="text-text-base">{approved}</span>
        </Row>
      </Show>
    </dl>
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

function DeviceRow(props: { device: AccountDevice; busy: boolean; onRevoke: () => void }) {
  const last = new Date(props.device.last_seen_at * 1000)
  const now = Date.now()
  const ago = humanAgo(now - last.getTime())
  return (
    <li class="flex items-center justify-between px-4 py-3">
      <div class="min-w-0">
        <div class="text-12-medium text-text-strong truncate">
          {props.device.device_label ?? "unknown device"}
        </div>
        <div class="text-10-regular text-text-subtle">
          last seen {ago} · session <code class="font-mono">{shortId(props.device.id)}</code>
        </div>
      </div>
      <Button variant="secondary" disabled={props.busy} onClick={() => props.onRevoke()}>
        {props.busy ? "…" : "Sign out"}
      </Button>
    </li>
  )
}

function SyncCard(props: { stats: SyncMe }) {
  const last = props.stats.lastPushedAt
    ? humanAgo(Date.now() - props.stats.lastPushedAt)
    : "never"
  const first = props.stats.firstPushedAt
    ? new Date(props.stats.firstPushedAt).toLocaleDateString()
    : "—"
  return (
    <div class="px-4 py-4 space-y-4">
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-12-regular">
        <Row label="Total events">
          <span class="text-text-strong">{props.stats.totalEvents.toLocaleString()}</span>
        </Row>
        <Row label="Aggregates">
          <span class="text-text-strong">{props.stats.uniqueAggregates}</span>
          <span class="text-text-subtle"> (sessions / projects)</span>
        </Row>
        <Row label="First sync">
          <span class="text-text-base">{first}</span>
        </Row>
        <Row label="Last sync">
          <span class="text-text-base">{last}</span>
        </Row>
      </dl>
      <Show when={props.stats.topAggregates.length > 0}>
        <div>
          <div class="text-12-semibold text-text-strong mb-2">Most recent activity</div>
          <ul class="divide-y divide-border-base rounded border border-border-base">
            <For each={props.stats.topAggregates}>
              {(a) => (
                <li class="flex items-center justify-between px-3 py-2 text-12-regular">
                  <code class="font-mono text-text-base truncate">{a.aggregate_id}</code>
                  <span class="text-text-subtle ml-2 shrink-0">{a.eventCount} events</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  )
}

function humanAgo(ms: number): string {
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

function shortId(id: string): string {
  if (id.length <= 14) return id
  return id.slice(0, 6) + "…" + id.slice(-6)
}
