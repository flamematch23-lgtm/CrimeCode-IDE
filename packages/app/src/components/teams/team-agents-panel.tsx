/**
 * TeamAgentsPanel — owner/admin manages a team's shared AI agents.
 *
 * Each agent is a named system-prompt template. Members invoke them
 * with `@<slug>` from the prompt input or chat (the autocomplete
 * lives in the prompt input). The system prompt is prepended to the
 * user's message before the AI call — invocation is client-side so
 * the local quota / model selection is preserved.
 *
 * Lifecycle:
 *   - Mount: list current agents (creates resource).
 *   - Create / edit / delete via inline forms.
 *   - Read-only mode for non-admin viewers (just shows the slug list).
 */
import { For, Show, createResource, createSignal } from "solid-js"
import { getTeamsClient, type TeamAgent } from "../../utils/teams-client"

interface Props {
  teamId: string
  /** "owner" | "admin" can manage; "member" | "viewer" can only read. */
  selfRole: "owner" | "admin" | "member" | "viewer"
}

interface DraftAgent {
  slug: string
  display_name: string
  system_prompt: string
  description: string
  model: string
}

const EMPTY_DRAFT: DraftAgent = {
  slug: "",
  display_name: "",
  system_prompt: "",
  description: "",
  model: "",
}

export function TeamAgentsPanel(props: Props) {
  const client = getTeamsClient()
  const canManage = () => props.selfRole === "owner" || props.selfRole === "admin"

  const [agents, { refetch }] = createResource<TeamAgent[]>(async () => {
    try {
      const r = await client.listAgents(props.teamId)
      return r.agents ?? []
    } catch {
      return []
    }
  })

  const [draft, setDraft] = createSignal<DraftAgent>({ ...EMPTY_DRAFT })
  const [editing, setEditing] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)

  function resetDraft() {
    setDraft({ ...EMPTY_DRAFT })
    setEditing(null)
    setErr(null)
  }

  function copyToClipboard(text: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return
    void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  async function onCreate(e: Event) {
    e.preventDefault()
    const d = draft()
    if (!d.display_name.trim() || !d.system_prompt.trim()) {
      setErr("Nome e system prompt sono obbligatori.")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const slug = (d.slug || d.display_name).trim()
      await client.createAgent(props.teamId, {
        slug,
        display_name: d.display_name.trim(),
        system_prompt: d.system_prompt.trim(),
        model: d.model.trim() || null,
        description: d.description.trim() || null,
      })
      resetDraft()
      await refetch()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  function startEdit(agent: TeamAgent) {
    setEditing(agent.id)
    setDraft({
      slug: agent.slug,
      display_name: agent.display_name,
      system_prompt: agent.system_prompt,
      description: agent.description ?? "",
      model: agent.model ?? "",
    })
    setErr(null)
  }

  async function onUpdate(e: Event) {
    e.preventDefault()
    const id = editing()
    if (!id) return
    const d = draft()
    setBusy(true)
    setErr(null)
    try {
      await client.updateAgent(props.teamId, id, {
        display_name: d.display_name.trim(),
        system_prompt: d.system_prompt.trim(),
        model: d.model.trim() || null,
        description: d.description.trim() || null,
      })
      resetDraft()
      await refetch()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Eliminare questo agent? L'azione è irreversibile.")) return
    setBusy(true)
    try {
      await client.deleteAgent(props.teamId, id)
      await refetch()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-component="team-agents-panel">
      <div data-slot="header">
        <h3>AI Agents condivisi</h3>
        <p data-slot="subtitle">
          Template di system prompt che ogni membro può invocare con <code>@slug</code> nel prompt o in chat.
        </p>
      </div>

      <Show when={agents.loading}>
        <div data-slot="loading">Caricamento…</div>
      </Show>

      <Show when={!agents.loading && (agents() ?? []).length === 0 && !canManage()}>
        <div data-slot="empty">
          Nessun agent definito. Chiedi a un admin di aggiungerne uno.
        </div>
      </Show>

      <Show when={(agents() ?? []).length > 0}>
        <ul data-slot="agent-list">
          <For each={agents() ?? []}>
            {(agent) => (
              <li data-slot="agent-row" data-editing={editing() === agent.id ? "true" : "false"}>
                <Show
                  when={editing() !== agent.id}
                  fallback={
                    <form onSubmit={onUpdate} data-slot="edit-form">
                      <input
                        data-slot="field-name"
                        value={draft().display_name}
                        onInput={(e) => setDraft({ ...draft(), display_name: e.currentTarget.value })}
                        placeholder="Nome visualizzato"
                        disabled={busy()}
                      />
                      <input
                        data-slot="field-model"
                        value={draft().model}
                        onInput={(e) => setDraft({ ...draft(), model: e.currentTarget.value })}
                        placeholder="Model id (opzionale, es. crimeopus-coder)"
                        disabled={busy()}
                      />
                      <input
                        data-slot="field-description"
                        value={draft().description}
                        onInput={(e) => setDraft({ ...draft(), description: e.currentTarget.value })}
                        placeholder="Descrizione breve"
                        disabled={busy()}
                      />
                      <textarea
                        data-slot="field-prompt"
                        value={draft().system_prompt}
                        onInput={(e) => setDraft({ ...draft(), system_prompt: e.currentTarget.value })}
                        placeholder="System prompt"
                        rows="6"
                        disabled={busy()}
                      />
                      <div data-slot="row-actions">
                        <button type="submit" disabled={busy()} data-variant="primary">
                          Salva
                        </button>
                        <button type="button" onClick={resetDraft} disabled={busy()}>
                          Annulla
                        </button>
                      </div>
                    </form>
                  }
                >
                  <div data-slot="agent-meta">
                    <div data-slot="agent-title">
                      <span data-slot="agent-slug">@{agent.slug}</span>
                      <span data-slot="agent-name">{agent.display_name}</span>
                    </div>
                    <Show when={agent.description}>
                      <p data-slot="agent-description">{agent.description}</p>
                    </Show>
                    <Show when={agent.model}>
                      <span data-slot="agent-model">model: {agent.model}</span>
                    </Show>
                    <pre data-slot="agent-prompt-preview">{agent.system_prompt.slice(0, 240)}{agent.system_prompt.length > 240 ? "…" : ""}</pre>
                  </div>
                  <div data-slot="agent-actions">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(agent.system_prompt)}
                      disabled={busy()}
                      title="Copia il system prompt negli appunti per incollarlo nel tuo prompt"
                    >
                      📋 Copia
                    </button>
                    <Show when={canManage()}>
                      <button type="button" onClick={() => startEdit(agent)} disabled={busy()}>
                        Modifica
                      </button>
                      <button type="button" onClick={() => onDelete(agent.id)} disabled={busy()} data-variant="danger">
                        Elimina
                      </button>
                    </Show>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={canManage() && editing() === null}>
        <form onSubmit={onCreate} data-slot="create-form">
          <h4>Nuovo agent</h4>
          <input
            data-slot="field-slug"
            value={draft().slug}
            onInput={(e) => setDraft({ ...draft(), slug: e.currentTarget.value })}
            placeholder="slug (es. linter, reviewer, translator)"
            disabled={busy()}
          />
          <input
            data-slot="field-name"
            value={draft().display_name}
            onInput={(e) => setDraft({ ...draft(), display_name: e.currentTarget.value })}
            placeholder="Nome visualizzato"
            disabled={busy()}
          />
          <input
            data-slot="field-model"
            value={draft().model}
            onInput={(e) => setDraft({ ...draft(), model: e.currentTarget.value })}
            placeholder="Model id (opzionale, es. crimeopus-coder)"
            disabled={busy()}
          />
          <input
            data-slot="field-description"
            value={draft().description}
            onInput={(e) => setDraft({ ...draft(), description: e.currentTarget.value })}
            placeholder="Descrizione breve (opzionale)"
            disabled={busy()}
          />
          <textarea
            data-slot="field-prompt"
            value={draft().system_prompt}
            onInput={(e) => setDraft({ ...draft(), system_prompt: e.currentTarget.value })}
            placeholder="System prompt — istruzioni che l'AI applica a ogni invocazione"
            rows="5"
            disabled={busy()}
          />
          <div data-slot="row-actions">
            <button type="submit" disabled={busy()} data-variant="primary">
              Crea agent
            </button>
          </div>
        </form>
      </Show>

      <Show when={err()}>
        <div data-slot="error">{err()}</div>
      </Show>
    </div>
  )
}
