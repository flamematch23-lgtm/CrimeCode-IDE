import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { getTeamsClient } from "@opencode-ai/app/utils/teams-client"

export function ManageTeamDialog(props: { teamId: string; onClose: () => void; onDeleted: () => void }) {
  const client = getTeamsClient()
  const [detail, { refetch }] = createResource(() => client.detail(props.teamId))
  const [identifier, setIdentifier] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [info, setInfo] = createSignal<string | null>(null)

  // Live updates — role changes, new members, removals all push an SSE event
  // so the dialog reflects reality even while open on multiple devices.
  onMount(() => {
    const unsub = client.subscribe(props.teamId, (ev) => {
      if (ev.type === "team_deleted") {
        props.onDeleted()
        return
      }
      if (
        ev.type === "member_added" ||
        ev.type === "member_removed" ||
        ev.type === "member_role_changed" ||
        ev.type === "team_renamed"
      ) {
        void refetch()
      }
    })
    onCleanup(unsub)
  })

  async function onAdd(e: Event) {
    e.preventDefault()
    const value = identifier().trim()
    if (!value) return
    setBusy("add")
    setErr(null)
    setInfo(null)
    try {
      const r = await client.addMember(props.teamId, value)
      setIdentifier("")
      await refetch()
      setInfo(r.mode === "added" ? "Member added." : `Invited ${value} — they'll join on next sign-in.`)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(null)
    }
  }

  async function onRemove(customerId: string) {
    if (!confirm("Remove this member from the team?")) return
    setBusy("remove:" + customerId)
    setErr(null)
    try {
      await client.removeMember(props.teamId, customerId)
      await refetch()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(null)
    }
  }

  async function onRoleChange(customerId: string, role: "admin" | "member") {
    setBusy("role:" + customerId)
    setErr(null)
    try {
      await client.setMemberRole(props.teamId, customerId, role)
      await refetch()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(null)
    }
  }

  async function onCancelInvite(inviteId: string) {
    setBusy("invite:" + inviteId)
    setErr(null)
    try {
      await client.cancelInvite(props.teamId, inviteId)
      await refetch()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(null)
    }
  }

  async function onDelete() {
    if (!confirm(`Delete team "${detail()?.team.name}"? This cannot be undone.`)) return
    setBusy("delete")
    setErr(null)
    try {
      await client.remove(props.teamId)
      props.onDeleted()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
      setBusy(null)
    }
  }

  return (
    <div data-component="team-dialog" role="dialog" aria-modal="true" aria-labelledby="manage-team-title">
      <div data-slot="backdrop" onClick={props.onClose} />
      <div data-slot="panel" data-wide="true">
        <button data-slot="close" onClick={props.onClose} aria-label="Close">×</button>
        <Show when={detail()} fallback={<div data-slot="loading">Loading…</div>}>
          {(d) => (
            <>
              <h2 id="manage-team-title">
                👥 {d().team.name}
              </h2>
              <p data-slot="subtitle">
                Manage team members and settings. As the {d().self_role}, you
                {d().self_role === "owner" ? " can add or remove members." : " can only view."}
              </p>

              <Show when={d().self_role !== "member"}>
                <form onSubmit={onAdd} data-slot="add-form">
                  <label>
                    <span>Add Team Member</span>
                    <div data-slot="input-row">
                      <input
                        type="text"
                        placeholder="@telegram-handle or member@example.com"
                        value={identifier()}
                        onInput={(e) => setIdentifier(e.currentTarget.value)}
                        disabled={busy() === "add"}
                      />
                      <button data-kind="primary" type="submit" disabled={busy() === "add" || !identifier().trim()}>
                        {busy() === "add" ? "…" : "Add"}
                      </button>
                    </div>
                  </label>
                </form>
              </Show>

              <div data-slot="members-section">
                <h3>Team Members ({d().members.length})</h3>
                <ul data-slot="members">
                  <For each={d().members}>
                    {(m) => (
                      <li data-slot="member">
                        <span data-slot="avatar">{(m.display ?? "?").slice(0, 1).toUpperCase()}</span>
                        <span data-slot="member-labels">
                          <span data-slot="member-name">{m.display ?? m.customer_id}</span>
                          <Show when={m.telegram}>
                            <span data-slot="member-telegram">{m.telegram}</span>
                          </Show>
                        </span>
                        <Show
                          when={d().self_role === "owner" && m.role !== "owner"}
                          fallback={<span data-slot="member-role" data-role={m.role}>{m.role}</span>}
                        >
                          <select
                            data-slot="role-select"
                            value={m.role}
                            disabled={busy() === "role:" + m.customer_id}
                            onChange={(e) =>
                              onRoleChange(m.customer_id, e.currentTarget.value as "admin" | "member")
                            }
                          >
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                          </select>
                        </Show>
                        <Show when={d().self_role === "owner" && m.role !== "owner"}>
                          <button
                            data-kind="ghost"
                            onClick={() => onRemove(m.customer_id)}
                            disabled={busy() === "remove:" + m.customer_id}
                            title="Remove member"
                          >
                            ✕
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </div>

              <Show when={d().invites.length > 0}>
                <div data-slot="invites-section">
                  <h3>Pending Invites ({d().invites.length})</h3>
                  <ul data-slot="invites">
                    <For each={d().invites}>
                      {(inv) => (
                        <li data-slot="invite">
                          <span data-slot="invite-identifier">{inv.identifier}</span>
                          <span data-slot="invite-date">
                            sent {new Date(inv.created_at * 1000).toLocaleDateString()}
                          </span>
                          <Show when={d().self_role !== "member"}>
                            <button
                              data-kind="ghost"
                              onClick={() => onCancelInvite(inv.id)}
                              disabled={busy() === "invite:" + inv.id}
                            >
                              Cancel
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <Show when={info()}><p data-slot="info">✓ {info()}</p></Show>
              <Show when={err()}><p data-slot="error">⚠️ {err()}</p></Show>

              <div data-slot="actions">
                <Show when={d().self_role === "owner"}>
                  <button data-kind="danger" onClick={onDelete} disabled={busy() === "delete"}>
                    🗑 Delete Team
                  </button>
                </Show>
                <button data-kind="ghost" onClick={props.onClose}>Close</button>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
