import { For, Show, createResource, createSignal } from "solid-js"

export function ManageTeamDialog(props: { teamId: string; onClose: () => void; onDeleted: () => void }) {
  const [detail, { refetch }] = createResource(() => window.api.teams.detail(props.teamId))
  const [identifier, setIdentifier] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  const [err, setErr] = createSignal<string | null>(null)
  const [info, setInfo] = createSignal<string | null>(null)

  async function onAdd(e: Event) {
    e.preventDefault()
    const value = identifier().trim()
    if (!value) return
    setBusy("add")
    setErr(null)
    setInfo(null)
    try {
      const r = await window.api.teams.addMember(props.teamId, value)
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
      await window.api.teams.removeMember(props.teamId, customerId)
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
      await window.api.teams.cancelInvite(props.teamId, inviteId)
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
      await window.api.teams.delete(props.teamId)
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
                        <span data-slot="member-role" data-role={m.role}>{m.role}</span>
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
