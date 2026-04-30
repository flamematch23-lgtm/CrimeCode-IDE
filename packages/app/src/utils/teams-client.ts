/**
 * Shared teams API client.
 *
 * Desktop: goes through IPC (window.api.teams.*) so CORS / auth are handled
 *   by the Electron main process.
 * Web:     calls the cloud API directly with `Authorization: Bearer <jwt>`
 *   pulled from localStorage.
 *
 * The same UI components in packages/app/src/components/teams pick one path
 * or the other via getClient().
 */

import { sseFetch } from "./sse-fetch"

export type TeamRole = "owner" | "admin" | "member" | "viewer"

export interface TeamSummary {
  id: string
  name: string
  owner_customer_id: string
  created_at: number
  role?: TeamRole
  member_count?: number
}

export interface TeamMember {
  team_id: string
  customer_id: string
  role: TeamRole
  added_at: number
  display: string | null
  telegram_user_id: number | null
  telegram: string | null
}

export interface TeamInvite {
  id: string
  team_id: string
  identifier: string
  role: TeamRole
  invited_by: string
  created_at: number
}

export interface TeamDetail {
  team: TeamSummary
  members: TeamMember[]
  invites: TeamInvite[]
  self_role: TeamRole
}

export interface TeamLiveSession {
  id: string
  team_id: string
  host_customer_id: string
  title: string
  state: string | null
  created_at: number
  last_heartbeat_at: number
  ended_at: number | null
}

export interface TeamEvent {
  type:
    | "hello"
    | "ping"
    | "session_started"
    | "session_heartbeat"
    | "session_ended"
    | "member_added"
    | "member_removed"
    | "member_role_changed"
    | "team_renamed"
    | "team_deleted"
    | "cursor_moved"
    | "chat_message"
    | "chat_typing"
    | "session_state"
    | "crdt_sync"
    | "crdt_awareness"
    | "chat_read"
  team_id?: string
  session_id?: string
  host?: string
  host_customer_id?: string
  title?: string
  customer_id?: string
  role?: string
  name?: string
  x?: number
  y?: number
  label?: string | null
  // chat_message / chat_typing
  message_id?: number
  author_name?: string | null
  text?: string
  ts?: number
  // session_state
  state?: unknown
  // chat_message attachment fields
  attachment_url?: string | null
  attachment_type?: string | null
  attachment_size?: number | null
  attachment_name?: string | null
  // crdt_sync / crdt_awareness
  doc_id?: string
  update_b64?: string
  awareness_b64?: string
  from_customer_id?: string
  // chat_read
  last_read_message_id?: number
}

export interface TeamChatRead {
  team_id: string
  customer_id: string
  last_read_message_id: number
  updated_at: number
}

export interface TeamAgent {
  id: string
  team_id: string
  slug: string
  display_name: string
  system_prompt: string
  model: string | null
  description: string | null
  created_by: string
  created_at: number
  updated_at: number
}

export interface CreateTeamAgentInput {
  slug: string
  display_name: string
  system_prompt: string
  model?: string | null
  description?: string | null
}

export interface UpdateTeamAgentInput {
  display_name?: string
  system_prompt?: string
  model?: string | null
  description?: string | null
}

export interface TeamChatAttachment {
  url: string
  type: string
  size: number
  name: string
}

export interface TeamChatMessage {
  id: number
  team_id: string
  customer_id: string
  author_name: string | null
  text: string
  ts: number
  attachment_url: string | null
  attachment_type: string | null
  attachment_size: number | null
  attachment_name: string | null
}

export interface TeamInviteLink {
  token: string
  team_id: string
  role: TeamRole
  created_by: string
  created_at: number
  expires_at: number | null
  max_uses: number | null
  uses: number
  revoked_at: number | null
}

export interface TeamInviteLinkPreview {
  team_id: string
  team_name: string
  role: TeamRole
  member_count: number
  expires_at: number | null
}

export interface AccountSession {
  status: "approved"
  token: string
  exp: number
  customer_id: string
}

/** Server says the signup/signin was valid but the account hasn't been
 * approved by the admin yet — no token is issued. The client has to poll
 * /auth/status/<cid> until the admin decides. */
export interface AccountPending {
  status: "pending"
  customer_id: string
}

export type AccountResult = AccountSession | AccountPending

export interface SignUpInput {
  username: string
  password: string
  telegram?: string
  email?: string
  device_label?: string
  referral_code?: string
}

export interface SignInInput {
  username: string
  password: string
  device_label?: string
}

/**
 * Classic password sign-up / sign-in. Returns either a full session or
 * a "pending" marker telling the caller to show the approval-wait UI.
 * Throws with the server-reported error code on failure
 * ("username_taken", "invalid_credentials", "rate_limited",
 *  "account_rejected").
 */
export async function signUpWithAccount(input: SignUpInput): Promise<AccountResult> {
  if (hasDesktopApi()) {
    const api = (window as any).api.account
    const result = await api.signUp({
      username: input.username,
      password: input.password,
      telegram: input.telegram,
      referral_code: input.referral_code,
    })
    // Write session to Electron store so sync works across devices
    if (result.status === "ok") {
      await api.writeSession(result.token, result.customer_id, result.exp)
    }
    return result
  }
  return accountJson("/license/auth/signup", input)
}

export async function signInWithAccount(input: SignInInput): Promise<AccountResult> {
  if (hasDesktopApi()) {
    const api = (window as any).api.account
    const result = await api.signIn({ username: input.username, password: input.password })
    // Write session to Electron store so sync works across devices
    if (result.status === "ok") {
      await api.writeSession(result.token, result.customer_id, result.exp)
    }
    return result
  }
  return accountJson("/license/auth/signin", input)
}

export async function fetchApprovalStatus(
  customerId: string,
): Promise<{ status: "pending" | "approved" | "rejected"; rejected_reason?: string | null }> {
  if (hasDesktopApi()) {
    return (window as any).api.account.approvalStatus(customerId)
  }
  const res = await fetch(`${API_BASE}/license/auth/status/${encodeURIComponent(customerId)}`)
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "error" in parsed
        ? (parsed as { error: string }).error
        : String(res.status)
    throw new Error(msg)
  }
  return parsed as { status: "pending" | "approved" | "rejected"; rejected_reason?: string | null }
}

async function accountJson(path: string, body: unknown): Promise<AccountResult> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  // 202 Accepted = pending approval, body has { status: 'pending', customer_id }
  if (res.status === 202 && parsed && typeof parsed === "object" && "customer_id" in parsed) {
    return parsed as AccountPending
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "error" in parsed
        ? (parsed as { error: string }).error
        : String(res.status)
    throw new Error(msg)
  }
  return parsed as AccountResult
}

export interface TeamsClient {
  list(): Promise<{ teams: TeamSummary[] }>
  create(name: string): Promise<{ team: TeamSummary }>
  detail(id: string): Promise<TeamDetail>
  rename(id: string, name: string): Promise<{ team: TeamSummary }>
  remove(id: string): Promise<{ ok: true }>
  addMember(id: string, identifier: string): Promise<{ mode: "added" | "invited" }>
  removeMember(id: string, customerId: string): Promise<{ ok: true }>
  setMemberRole(id: string, customerId: string, role: TeamRole): Promise<{ member: TeamMember }>
  cancelInvite(id: string, inviteId: string): Promise<{ ok: true }>
  listSessions(id: string): Promise<{ sessions: TeamLiveSession[] }>
  publishSession(id: string, title: string, state: unknown): Promise<TeamLiveSession>
  heartbeatSession(id: string, sid: string, state: unknown): Promise<TeamLiveSession | null>
  endSession(id: string, sid: string): Promise<{ ok: true }>
  /** Transfer ownership of a team to another member. Owner-only. */
  transferOwnership(id: string, newOwnerCustomerId: string): Promise<{ team: TeamSummary }>
  /** Publish a cursor position for a live session. Fire-and-forget. */
  publishCursor(id: string, sid: string, x: number, y: number, label?: string): Promise<void>
  /** Read the current shared workspace state of a session — used by
   *  guests when they begin to follow a host so they hydrate immediately
   *  instead of waiting for the next state push. */
  getSession(
    id: string,
    sid: string,
  ): Promise<{ state: unknown; host_customer_id: string; last_heartbeat_at?: number } | null>
  /** List the most-recent chat messages for a team (oldest-first). */
  listChat(id: string, limit?: number): Promise<{ messages: TeamChatMessage[] }>
  /** Post a chat message. The server captures the author name. */
  postChat(id: string, text: string, attachment?: TeamChatAttachment | null): Promise<{ message: TeamChatMessage }>
  /** Notify other members that the local user is typing. Fire-and-forget. */
  postTyping(id: string): Promise<void>
  /** Open an SSE subscription. Returns an unsubscribe. */
  subscribe(id: string, onEvent: (e: TeamEvent) => void): () => void
  /** Upload an image/PDF to be attached to a subsequent chat message. */
  uploadChatAttachment(id: string, file: File): Promise<TeamChatAttachment>
  /** Generate a shareable invite URL for a team. Owner/admin only. */
  createInviteLink(
    id: string,
    opts?: { role?: "member" | "viewer"; ttl_ms?: number | null; max_uses?: number | null },
  ): Promise<{ link: TeamInviteLink }>
  listInviteLinks(id: string): Promise<{ links: TeamInviteLink[] }>
  revokeInviteLink(id: string, token: string): Promise<{ ok: true }>
  /** Public preview of an invite link — no auth required. */
  previewInviteLink(token: string): Promise<TeamInviteLinkPreview | null>
  /** Redeem an invite link as the current user. Returns the joined team. */
  redeemInviteLink(token: string): Promise<{ team: TeamSummary; role: TeamRole; already_member: boolean }>
  /** Broadcast a CRDT update (sync or awareness) to all session members via SSE. Fire-and-forget. */
  postCrdt(teamId: string, sessionId: string, msg: { type: string; doc_id: string; update_b64?: string; awareness_b64?: string }): Promise<void>
  /** Mark a chat message as read by the current user (high-water-mark). */
  markChatRead(teamId: string, messageId: number): Promise<void>
  /** Hydrate the read-receipt state for a team on chat-panel mount. */
  listChatReads(teamId: string): Promise<{ reads: TeamChatRead[] }>
  /** List all custom AI agents defined for the team. Members may invoke; admins manage. */
  listAgents(teamId: string): Promise<{ agents: TeamAgent[] }>
  /** Create a new shared agent. Owner/admin only. */
  createAgent(teamId: string, input: CreateTeamAgentInput): Promise<{ agent: TeamAgent }>
  /** Edit an existing agent. Owner/admin only. */
  updateAgent(teamId: string, agentId: string, input: UpdateTeamAgentInput): Promise<{ agent: TeamAgent }>
  /** Remove an agent. Owner/admin only. */
  deleteAgent(teamId: string, agentId: string): Promise<{ ok: true }>
}

// ─── Desktop (IPC) ────────────────────────────────────────────────────────

function hasDesktopApi(): boolean {
  return typeof window !== "undefined" && typeof (window as any).api?.teams?.list === "function"
}

function desktopClient(): TeamsClient {
  const api = () => (window as any).api.teams
  return {
    list: () => api().list(),
    create: (name) => api().create(name),
    detail: (id) => api().detail(id),
    rename: (id, name) => api().rename(id, name),
    remove: (id) => api().delete(id),
    addMember: (id, identifier) => api().addMember(id, identifier),
    removeMember: (id, cid) => api().removeMember(id, cid),
    setMemberRole: (id, cid, role) => (window as any).api.teams.setMemberRole(id, cid, role),
    cancelInvite: (id, inviteId) => api().cancelInvite(id, inviteId),
    listSessions: (id) => api().listSessions(id),
    publishSession: (id, title, state) => api().publishSession(id, title, state),
    heartbeatSession: (id, sid, state) => api().heartbeatSession(id, sid, state),
    endSession: (id, sid) => api().endSession(id, sid),
    transferOwnership: (id, newOwnerCustomerId) =>
      typeof api().transferOwnership === "function"
        ? api().transferOwnership(id, newOwnerCustomerId)
        : webClient().transferOwnership(id, newOwnerCustomerId),
    // Older preload bundles may not expose publishCursor — feature-detect
    // and silently no-op (or fall back to web). Without this guard,
    // mouse-move events throw "publishCursor is not a function" hundreds of
    // times per second and crater the renderer.
    publishCursor: (id, sid, x, y, label) => {
      const teams = api()
      if (typeof teams?.publishCursor === "function") {
        return teams.publishCursor(id, sid, x, y, label)
      }
      // No IPC binding — fire-and-forget via the web client (which is also
      // a no-op when there's no session). Wrapped in try so a missing
      // session doesn't bubble up to the mouse-move handler.
      try {
        return webClient().publishCursor(id, sid, x, y, label)
      } catch {
        return Promise.resolve()
      }
    },
    getSession: (id, sid) => {
      const teams = api()
      if (typeof teams?.getSession === "function") return teams.getSession(id, sid)
      return webClient().getSession(id, sid)
    },
    listChat: (id, limit) => {
      const teams = api()
      if (typeof teams?.listChat === "function") return teams.listChat(id, limit)
      return webClient().listChat(id, limit)
    },
    postChat: (id, text, attachment) => {
      // Always go through the web client so attachments flow uniformly. The
      // older desktop IPC postChat only forwards text and would silently drop
      // attachments — fall through to fetch-with-Bearer when an attachment
      // is present.
      if (attachment) return webClient().postChat(id, text, attachment)
      const teams = api()
      if (typeof teams?.postChat === "function") return teams.postChat(id, text)
      return webClient().postChat(id, text)
    },
    postTyping: (id) => {
      const teams = api()
      if (typeof teams?.postTyping === "function") return teams.postTyping(id)
      try {
        return webClient().postTyping(id)
      } catch {
        return Promise.resolve()
      }
    },
    subscribe: (id, onEvent) => {
      const teams = api()
      // Prefer the IPC-bridged subscription so the JWT stays in the main
      // process and we get automatic reconnect / backoff. Fall back to the
      // web client (fetch-based SSE) for older preload bundles or when the
      // current login is web-only.
      if (typeof teams?.subscribe === "function") {
        return teams.subscribe(id, (ev: unknown) => {
          if (ev && typeof ev === "object") onEvent(ev as TeamEvent)
        })
      }
      return webClient().subscribe(id, onEvent)
    },
    // Attachment upload + invite links + CRDT go through the web client
    // (fetch+Bearer) regardless of desktop mode — the desktop IPC layer doesn't
    // yet have these handlers and they're infrequent enough that Bearer-via-fetch is fine.
    uploadChatAttachment: (id, file) => webClient().uploadChatAttachment(id, file),
    createInviteLink: (id, opts) => webClient().createInviteLink(id, opts),
    listInviteLinks: (id) => webClient().listInviteLinks(id),
    revokeInviteLink: (id, token) => webClient().revokeInviteLink(id, token),
    previewInviteLink: (token) => webClient().previewInviteLink(token),
    redeemInviteLink: (token) => webClient().redeemInviteLink(token),
    postCrdt: (teamId, sessionId, msg) => webClient().postCrdt(teamId, sessionId, msg),
    markChatRead: (teamId, messageId) => webClient().markChatRead(teamId, messageId),
    listChatReads: (teamId) => webClient().listChatReads(teamId),
    listAgents: (teamId) => webClient().listAgents(teamId),
    createAgent: (teamId, input) => webClient().createAgent(teamId, input),
    updateAgent: (teamId, agentId, input) => webClient().updateAgent(teamId, agentId, input),
    deleteAgent: (teamId, agentId) => webClient().deleteAgent(teamId, agentId),
  }
}

// ─── Web (fetch + Bearer) ─────────────────────────────────────────────────

const LS_SESSION_KEY = "crimecode.session"

interface WebSession {
  token: string
  customer_id: string
  telegram_user_id: number | null
  expires_at: number
}

export function readWebSession(): WebSession | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_SESSION_KEY) : null
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WebSession>
    if (!parsed.token || !parsed.customer_id || !parsed.expires_at) return null
    if (parsed.expires_at <= Math.floor(Date.now() / 1000)) return null
    return parsed as WebSession
  } catch {
    return null
  }
}

export function writeWebSession(s: WebSession | null): void {
  if (typeof localStorage === "undefined") return
  if (s) localStorage.setItem(LS_SESSION_KEY, JSON.stringify(s))
  else localStorage.removeItem(LS_SESSION_KEY)
}

const API_BASE = (() => {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
  const explicit = meta?.env?.VITE_LICENSE_API_URL
  if (explicit) return String(explicit).replace(/\/+$/, "")
  // Fallback for web builds: production endpoint. Desktop never uses this
  // branch because hasDesktopApi() short-circuits earlier.
  return "https://api.crimecode.cc"
})()

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const s = readWebSession()
  const headers = new Headers(init.headers ?? {})
  if (s) headers.set("Authorization", `Bearer ${s.token}`)
  headers.set("Content-Type", "application/json")
  return fetch(`${API_BASE}${path}`, { ...init, headers })
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body ? (body as { error: string }).error : String(res.status)
    throw new Error(msg)
  }
  return body as T
}

function webClient(): TeamsClient {
  return {
    list: () => json(`/license/teams`),
    create: (name) => json(`/license/teams`, { method: "POST", body: JSON.stringify({ name }) }),
    detail: (id) => json(`/license/teams/${encodeURIComponent(id)}`),
    rename: (id, name) =>
      json(`/license/teams/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    remove: (id) => json(`/license/teams/${encodeURIComponent(id)}`, { method: "DELETE" }),
    addMember: (id, identifier) =>
      json(`/license/teams/${encodeURIComponent(id)}/members`, {
        method: "POST",
        body: JSON.stringify({ identifier }),
      }),
    removeMember: (id, cid) =>
      json(`/license/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(cid)}`, { method: "DELETE" }),
    setMemberRole: (id, cid, role) =>
      json(`/license/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(cid)}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    cancelInvite: (id, inviteId) =>
      json(`/license/teams/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }),
    listSessions: (id) => json(`/license/teams/${encodeURIComponent(id)}/sessions`),
    publishSession: (id, title, state) =>
      json(`/license/teams/${encodeURIComponent(id)}/sessions`, {
        method: "POST",
        body: JSON.stringify({ title, state }),
      }),
    heartbeatSession: (id, sid, state) =>
      json(`/license/teams/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ state }),
      }),
    endSession: (id, sid) =>
      json(`/license/teams/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" }),
    transferOwnership: (id, newOwnerCustomerId) =>
      json(`/license/teams/${encodeURIComponent(id)}/transfer-ownership`, {
        method: "POST",
        body: JSON.stringify({ new_owner_customer_id: newOwnerCustomerId }),
      }),
    publishCursor: async (id, sid, x, y, label) => {
      await apiFetch(`/license/teams/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}/cursor`, {
        method: "POST",
        body: JSON.stringify({ x, y, label }),
      }).catch(() => undefined)
    },
    getSession: async (id, sid) => {
      try {
        return await json(`/license/teams/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}`)
      } catch {
        return null
      }
    },
    listChat: (id, limit) =>
      json(`/license/teams/${encodeURIComponent(id)}/chat${limit ? "?limit=" + limit : ""}`),
    postChat: (id, text, attachment) =>
      json(`/license/teams/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        body: JSON.stringify({ text, attachment: attachment ?? null }),
      }),
    postTyping: async (id) => {
      await apiFetch(`/license/teams/${encodeURIComponent(id)}/chat/typing`, { method: "POST" }).catch(() => undefined)
    },
    subscribe: (id, onEvent) => {
      const s = readWebSession()
      if (!s) return () => undefined
      // POST + Authorization header instead of EventSource + `?access_token=`.
      // The token used to leak into server logs, browser history and proxy
      // referrers; sse-fetch wraps a fetch ReadableStream so the JWT stays
      // strictly inside the request header.
      const handle = sseFetch({
        url: `${API_BASE}/license/teams/${encodeURIComponent(id)}/events-stream`,
        method: "POST",
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.token}`,
        },
        onEvent: (e) => {
          // Filter heartbeats — the server emits `event: ping` every 25s
          // to keep idle proxies from closing the connection. Hello frames
          // are also book-keeping; nobody upstream cares.
          if (e.event === "ping" || e.event === "hello") return
          try {
            const ev = JSON.parse(e.data) as TeamEvent
            // Defence-in-depth: drop events whose `team_id` doesn't match
            // the subscription. Server already scopes via subscribeTeam,
            // but we double-check on the client to avoid cross-team leaks
            // if a future bug surfaces upstream.
            if ((ev as { team_id?: string }).team_id && (ev as { team_id?: string }).team_id !== id) return
            onEvent(ev)
          } catch {
            /* ignore malformed events */
          }
        },
        onError: (err) => {
          // Auth failures land here. We don't surface them to the caller
          // (the .subscribe contract is fire-and-forget) — just stop.
          console.warn("[teams-client] subscribe stream ended", err.message)
        },
      })
      return () => handle.close()
    },
    uploadChatAttachment: async (id, file) => {
      const s = readWebSession()
      if (!s) throw new Error("not_signed_in")
      const buf = await file.arrayBuffer()
      const res = await fetch(
        `${API_BASE}/license/teams/${encodeURIComponent(id)}/chat/upload`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type,
            "X-Attachment-Name": encodeURIComponent(file.name),
            Authorization: `Bearer ${s.token}`,
          },
          body: buf,
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "upload_failed" }))
        throw new Error((err as { error?: string }).error ?? `upload_failed_${res.status}`)
      }
      return (await res.json()) as TeamChatAttachment
    },
    createInviteLink: (id, opts) =>
      json(`/license/teams/${encodeURIComponent(id)}/invite-links`, {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      }),
    listInviteLinks: (id) => json(`/license/teams/${encodeURIComponent(id)}/invite-links`),
    revokeInviteLink: (id, token) =>
      json(`/license/teams/${encodeURIComponent(id)}/invite-links/${encodeURIComponent(token)}`, {
        method: "DELETE",
      }),
    previewInviteLink: async (token) => {
      // No auth — public preview.
      const res = await fetch(`${API_BASE}/license/invite-links/${encodeURIComponent(token)}`)
      if (!res.ok) return null
      return (await res.json()) as TeamInviteLinkPreview
    },
    redeemInviteLink: (token) =>
      json(`/license/invite-links/${encodeURIComponent(token)}/redeem`, { method: "POST" }),
    postCrdt: async (teamId, sessionId, msg) => {
      await apiFetch(
        `/license/teams/${encodeURIComponent(teamId)}/sessions/${encodeURIComponent(sessionId)}/crdt`,
        { method: "POST", body: JSON.stringify(msg) },
      ).catch(() => undefined)
    },
    markChatRead: async (teamId, messageId) => {
      await apiFetch(`/license/teams/${encodeURIComponent(teamId)}/chat/read`, {
        method: "POST",
        body: JSON.stringify({ message_id: messageId }),
      }).catch(() => undefined)
    },
    listChatReads: (teamId) => json(`/license/teams/${encodeURIComponent(teamId)}/chat/reads`),
    listAgents: (teamId) => json(`/license/teams/${encodeURIComponent(teamId)}/agents`),
    createAgent: (teamId, input) =>
      json(`/license/teams/${encodeURIComponent(teamId)}/agents`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateAgent: (teamId, agentId, input) =>
      json(`/license/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    deleteAgent: (teamId, agentId) =>
      json(`/license/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
      }),
  }
}

// ─── Sync Client ───────────────────────────────────────────────────────

export interface SyncClient {
  get(key: string): Promise<{ key: string; value: string; updated_at: number } | null>
  put(key: string, value: string): Promise<{ key: string; value: string; updated_at: number }>
  list(): Promise<Array<{ key: string; value: string; updated_at: number }>>
}

function desktopSyncClient(): SyncClient {
  const api = () => (window as any).api.account
  return {
    get: (key) => api().syncGet(key),
    put: (key, value) => api().syncPut(key, value),
    list: () => api().syncList(),
  }
}

function webSyncClient(): SyncClient {
  return {
    get: (key) => json(`/license/sync/${encodeURIComponent(key)}`),
    put: (key, value) =>
      json(`/license/sync/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    list: () => json(`/license/sync`).then((b: any) => b.entries ?? []),
  }
}

let _syncCached: SyncClient | null = null

export function getSyncClient(): SyncClient {
  if (_syncCached) return _syncCached
  _syncCached = hasDesktopApi() ? desktopSyncClient() : webSyncClient()
  return _syncCached
}

// ─── Entry point ──────────────────────────────────────────────────────────

let _cached: TeamsClient | null = null

export function getTeamsClient(): TeamsClient {
  if (_cached) return _cached
  _cached = hasDesktopApi() ? desktopClient() : webClient()
  return _cached
}

// ─── Logout (desktop-aware) ────────────────────────────────────────────────

export async function logout(): Promise<void> {
  if (hasDesktopApi()) {
    await (window as any).api.account.logout()
  }
  // Always clear web session too (localStorage) so both paths are consistent
  writeWebSession(null)
}
