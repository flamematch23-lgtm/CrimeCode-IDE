import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useServer } from "@/context/server"
import {
  getAccountMe,
  getAccountDevices,
  getReferralInfo,
  getSyncMe,
  getSyncStatus,
  hasAccountSession,
  redeemReferralCode,
  revokeDevice,
  logoutAllDevices,
  triggerSyncNow,
  type AccountDevice,
  type AccountMe,
  type ReferralInfo,
  type SyncMe,
} from "@/utils/account-client"
import { clearCredentials } from "@/pages/auth-gate"
import { readWebSession, writeWebSession } from "@/utils/teams-client"
import { configureCloudSyncIfDesktop } from "@/utils/cloud-sync"

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

  // Local sidecar's CloudClient state — separate from the cloud-side
  // sync stats above. If `configured: false`, the local CloudClient
  // has no {api, token} pair to push with → Sync-now is a no-op until
  // the user re-links by clicking the button below.
  const [syncStatus, syncStatusActions] = createResource(localCreds, async (creds) => {
    if (!creds) return null
    return getSyncStatus(creds)
  })

  // Referral info — shareable code, claim history, eligibility flag for the
  // "redeem a code from a friend" form below.
  const [referral, referralActions] = createResource(signedIn, async (yes) => {
    if (!yes) return null
    try {
      return await getReferralInfo()
    } catch {
      return null
    }
  })

  const [redeemCode, setRedeemCode] = createSignal("")

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

  async function onCopyToClipboard(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      flash(`${what} copied to clipboard.`)
    } catch {
      // Fallback: legacy execCommand for older browsers/electron with disabled clipboard.
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand("copy")
        flash(`${what} copied to clipboard.`)
      } finally {
        document.body.removeChild(ta)
      }
    }
  }

  function onShareViaTelegram(url: string) {
    const text = encodeURIComponent(`Try CrimeCode IDE — sign up via my link and we both get bonus trial days: ${url}`)
    window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${text}`, "_blank", "noopener")
  }

  async function onRedeemCode() {
    const code = redeemCode().trim().toUpperCase()
    if (!code || !/^[A-Z0-9]{4,32}$/.test(code)) {
      flash("Inserisci un codice valido (4–32 caratteri).")
      return
    }
    setBusy("redeem-referral")
    try {
      const r = await redeemReferralCode(code)
      flash(`🎁 Bonus applied: +${r.referred_bonus_days} days`)
      setRedeemCode("")
      referralActions.refetch()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Surface a friendlier message for the most common server reasons.
      const friendly = msg.includes("self_referral")
        ? "You can't redeem your own code."
        : msg.includes("already_claimed") || msg.includes("ineligible")
          ? "You've already redeemed a code on this account."
          : msg.includes("monthly_cap")
            ? "The referrer has hit their monthly cap. Try a different code."
            : msg.includes("unknown_code") || msg.includes("bad_code")
              ? "That code doesn't exist."
              : msg
      flash("Redeem failed: " + friendly)
    } finally {
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
      if (r.ok) {
        flash(`Sync OK — pushed ${r.pushed}, pulled ${r.pulled}.`)
      } else if (r.error === "not configured") {
        // Don't blame the user with a useless toast — surface the
        // re-link path instead.
        flash("Sync isn't configured on this device. Click Re-link below.")
      } else {
        flash("Sync skipped: " + (r.error ?? "unknown reason"))
      }
      syncActions.refetch()
      syncStatusActions.refetch()
    } catch (err) {
      flash("Sync failed: " + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Re-link this device: re-runs the same configure-sidecar call the
   * login flow does, using the Bearer token currently in webSession.
   * Useful after a sidecar restart that dropped the in-memory config
   * before v2.22.21 added on-disk persistence — and as a manual
   * recovery path even after that fix lands.
   */
  async function onRelink() {
    const ws = readWebSession()
    if (!ws) {
      flash("Sign in first — there's no Bearer token to link with.")
      return
    }
    setBusy("relink")
    try {
      await configureCloudSyncIfDesktop(ws.token)
      // Give the sidecar a beat to flip configured=true before we re-poll.
      await new Promise((r) => setTimeout(r, 500))
      syncStatusActions.refetch()
      flash("Device linked — sync should now run on its own.")
    } catch (err) {
      flash("Re-link failed: " + (err instanceof Error ? err.message : String(err)))
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
            onRefresh={() => {
              syncActions.refetch()
              syncStatusActions.refetch()
            }}
            loading={sync.loading || syncStatus.loading}
            right={
              <Show
                when={syncStatus()?.configured}
                fallback={
                  <Button variant="primary" disabled={busy() === "relink"} onClick={onRelink}>
                    {busy() === "relink" ? "Linking…" : "🔗 Link this device"}
                  </Button>
                }
              >
                <Button variant="secondary" disabled={busy() === "sync-now"} onClick={onSyncNow}>
                  {busy() === "sync-now" ? "Syncing…" : "Sync now"}
                </Button>
              </Show>
            }
          >
            <Show
              when={syncStatus()?.configured}
              fallback={
                <Empty>
                  Cloud sync isn't linked to this device yet. Click <strong>Link this device</strong> above
                  to push your local sessions to your account and pick up changes from your other devices.
                </Empty>
              }
            >
              <Show when={sync()} fallback={<Empty>Linked. No events synced yet — try opening a session.</Empty>}>
                {(s) => <SyncCard stats={s()} />}
              </Show>
            </Show>
          </Section>

          {/* ───────── Referral ───────── */}
          <Section
            title="🎁 Refer a friend"
            onRefresh={() => referralActions.refetch()}
            loading={referral.loading}
          >
            <Show
              when={referral()}
              fallback={<Empty>Loading referral info…</Empty>}
            >
              {(rRes) => (
                <ReferralCard
                  referral={rRes()!}
                  redeemCode={redeemCode()}
                  setRedeemCode={setRedeemCode}
                  onCopy={onCopyToClipboard}
                  onShareTelegram={onShareViaTelegram}
                  onRedeem={onRedeemCode}
                  busyKey={busy()}
                />
              )}
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

function ReferralCard(props: {
  referral: ReferralInfo
  redeemCode: string
  setRedeemCode: (v: string) => void
  onCopy: (text: string, what: string) => void
  onShareTelegram: (url: string) => void
  onRedeem: () => void
  busyKey: string | null
}) {
  const totalEarned = () => props.referral.claims.reduce((acc, c) => acc + c.referrer_bonus_days, 0)
  const claimsCount = () => props.referral.claims.length
  return (
    <div class="px-4 py-4 space-y-5">
      <p class="text-12-regular text-text-subtle">
        Share your code or link with a friend. They get{" "}
        <strong class="text-text-strong">+{props.referral.bonus.referred} days</strong> bonus on
        signup, and you get <strong class="text-text-strong">+{props.referral.bonus.referrer} days</strong>{" "}
        when they join. Cap: {props.referral.bonus.monthlyCap} bonus days per 30 rolling days.
      </p>

      {/* Code + share link, both with copy buttons */}
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-12-medium text-text-subtle w-20">Your code</span>
          <code class="flex-1 font-mono text-13-medium text-text-strong px-3 py-2 rounded border border-border-base bg-surface-base">
            {props.referral.code}
          </code>
          <Button variant="secondary" onClick={() => props.onCopy(props.referral.code, "Code")}>
            Copy
          </Button>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-12-medium text-text-subtle w-20">Share link</span>
          <code class="flex-1 font-mono text-12-regular text-text-strong px-3 py-2 rounded border border-border-base bg-surface-base truncate">
            {props.referral.shareUrl}
          </code>
          <Button variant="secondary" onClick={() => props.onCopy(props.referral.shareUrl, "Link")}>
            Copy
          </Button>
          <Button variant="secondary" onClick={() => props.onShareTelegram(props.referral.shareUrl)}>
            ✈️ Telegram
          </Button>
        </div>
      </div>

      {/* Counters */}
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-12-regular">
        <Row label="Claims">
          <span class="text-text-strong">{claimsCount()}</span>
        </Row>
        <Row label="Total earned">
          <span class="text-text-strong">{totalEarned()} days</span>
        </Row>
      </dl>

      {/* Recent claims list */}
      <Show when={claimsCount() > 0}>
        <div>
          <p class="text-12-medium text-text-subtle mb-2">Recent claims</p>
          <ul class="text-12-regular text-text-base divide-y divide-border-base border border-border-base rounded">
            <For each={props.referral.claims.slice(0, 5)}>
              {(c) => (
                <li class="px-3 py-2 flex items-center justify-between gap-3">
                  <code class="font-mono">{shortId(c.referred_customer_id)}</code>
                  <span class="text-text-subtle">{humanAgo(Date.now() - c.claimed_at * 1000)}</span>
                  <span class="text-text-strong">+{c.referrer_bonus_days}d</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      {/* "Got a code from a friend?" — only shown when eligible */}
      <Show when={props.referral.eligibleToRedeem}>
        <div class="pt-3 border-t border-border-base space-y-2">
          <p class="text-12-medium text-text-strong">Got a code from a friend?</p>
          <p class="text-12-regular text-text-subtle">
            Redeem it within 24 hours of signup to claim your bonus +{props.referral.bonus.referred} days.
          </p>
          <div class="flex items-center gap-2">
            <input
              type="text"
              class="flex-1 font-mono text-13-medium text-text-strong px-3 py-2 rounded border border-border-base bg-surface-base"
              value={props.redeemCode}
              maxlength="32"
              placeholder="e.g. SHQX3J5X"
              onInput={(e) => props.setRedeemCode(e.currentTarget.value.toUpperCase())}
            />
            <Button
              variant="primary"
              disabled={props.busyKey === "redeem-referral" || !props.redeemCode.trim()}
              onClick={() => props.onRedeem()}
            >
              {props.busyKey === "redeem-referral" ? "Redeeming…" : "Redeem"}
            </Button>
          </div>
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
