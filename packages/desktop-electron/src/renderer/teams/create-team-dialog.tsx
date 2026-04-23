import { Show, createSignal } from "solid-js"
import type { TeamSummary } from "../../preload/types"

export function CreateTeamDialog(props: { onClose: () => void; onCreated: (team: TeamSummary) => void }) {
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)

  async function onSubmit(e: Event) {
    e.preventDefault()
    if (busy()) return
    const value = name().trim()
    if (!value) return
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.teams.create(value)
      props.onCreated(r.team)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-component="team-dialog" role="dialog" aria-modal="true" aria-labelledby="create-team-title">
      <div data-slot="backdrop" onClick={props.onClose} />
      <div data-slot="panel">
        <button data-slot="close" onClick={props.onClose} aria-label="Close">×</button>
        <h2 id="create-team-title">Create New Team</h2>
        <p data-slot="subtitle">Create a team to collaborate with others.</p>
        <form onSubmit={onSubmit}>
          <label>
            <span>Team Name</span>
            <input
              type="text"
              placeholder="Enter team name"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              disabled={busy()}
              maxlength="80"
              autofocus
            />
          </label>
          <Show when={err()}><p data-slot="error">⚠️ {err()}</p></Show>
          <div data-slot="actions">
            <button data-kind="ghost" type="button" onClick={props.onClose} disabled={busy()}>Cancel</button>
            <button data-kind="primary" type="submit" disabled={busy() || !name().trim()}>
              {busy() ? "Creating…" : "Create Team"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
