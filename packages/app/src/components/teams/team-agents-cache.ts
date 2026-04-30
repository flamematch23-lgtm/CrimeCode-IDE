/**
 * In-process cache of team agents for the active team. Populated when the
 * user enters a team workspace and consumed at prompt-submit time to expand
 * leading `@<slug>` mentions into the agent's system prompt.
 *
 * Why a global cache instead of a context: the prompt-submit pipeline is
 * a pure function (submit.ts, sendFollowupDraft) without access to Solid
 * contexts. A tiny module-level Map keeps the API ergonomic without
 * having to thread a context through.
 *
 * Lifecycle: workspace-switcher writes whenever the active team changes;
 * SharedWorkspacePublisher refreshes it whenever a team SSE event hints
 * at agent CRUD. Stale entries are fine — worst case the user sees the
 * raw `@slug` in their message until the cache refreshes (~ a few sec).
 */

import { getTeamsClient, type TeamAgent } from "../../utils/teams-client"

const SLUG_RE = /^@([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\b\s*/i

let cachedTeamId: string | null = null
let cachedAgents: TeamAgent[] = []
let inFlight: Promise<void> | null = null

export async function refreshTeamAgents(teamId: string | null): Promise<void> {
  if (!teamId) {
    cachedTeamId = null
    cachedAgents = []
    return
  }
  if (inFlight) {
    try {
      await inFlight
    } catch {
      /* ignore */
    }
  }
  inFlight = (async () => {
    try {
      const r = await getTeamsClient().listAgents(teamId)
      cachedTeamId = teamId
      cachedAgents = r.agents ?? []
    } catch {
      // Network failure — keep the previous cache rather than dropping it.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function getCachedTeamAgents(): { teamId: string | null; agents: TeamAgent[] } {
  return { teamId: cachedTeamId, agents: cachedAgents }
}

/**
 * If `text` starts with `@<slug>` and a matching team agent exists,
 * return the expanded form: `<system-prompt>\n\n<remaining-text>`.
 * Otherwise return `text` unchanged.
 */
export function expandTeamAgentMention(text: string): string {
  if (!text || cachedAgents.length === 0) return text
  const m = text.match(SLUG_RE)
  if (!m) return text
  const slug = m[1].toLowerCase()
  const agent = cachedAgents.find((a) => a.slug.toLowerCase() === slug)
  if (!agent) return text
  const rest = text.slice(m[0].length)
  return `${agent.system_prompt}\n\n${rest}`
}
