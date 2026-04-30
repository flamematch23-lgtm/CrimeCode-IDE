import { randomBytes } from "node:crypto"
import { getDb } from "./db"
import { emitTeamEvent } from "./team-events"

type Role = "owner" | "admin" | "member" | "viewer"

/** Roles that can post chat / publish session state. Viewers are read-only. */
function canWrite(role: Role | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "member"
}

export interface TeamRow {
  id: string
  name: string
  owner_customer_id: string
  created_at: number
}

export interface TeamMemberRow {
  team_id: string
  customer_id: string
  role: Role
  added_at: number
}

export interface TeamInviteRow {
  id: string
  team_id: string
  identifier: string
  role: Role
  invited_by: string
  created_at: number
}

export interface TeamSessionRow {
  id: string
  team_id: string
  host_customer_id: string
  title: string
  state: string | null
  created_at: number
  last_heartbeat_at: number
  ended_at: number | null
}

export interface TeamDetail {
  team: TeamRow
  members: Array<
    TeamMemberRow & {
      display: string | null
      telegram_user_id: number | null
      telegram: string | null
    }
  >
  invites: TeamInviteRow[]
  self_role: Role
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function normalizeIdentifier(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("@")) return trimmed.toLowerCase()
  if (trimmed.includes("@")) return trimmed.toLowerCase() // email
  return "@" + trimmed.toLowerCase()
}

/* ──────────────────────────  Team CRUD  ────────────────────────── */

export function createTeam(owner: string, name: string): TeamRow {
  const cleanName = name.trim()
  if (!cleanName || cleanName.length > 80) throw new Error("invalid_name")
  const id = newId("team")
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      "INSERT INTO teams (id, name, owner_customer_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, cleanName, owner, now())
    db.prepare(
      "INSERT INTO team_members (team_id, customer_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    ).run(id, owner, now())
  })()
  return db.prepare<TeamRow, [string]>("SELECT * FROM teams WHERE id = ?").get(id)!
}

export function renameTeam(teamId: string, actor: string, name: string): TeamRow {
  const cleanName = name.trim()
  if (!cleanName || cleanName.length > 80) throw new Error("invalid_name")
  const role = getMemberRole(teamId, actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  getDb().prepare("UPDATE teams SET name = ? WHERE id = ?").run(cleanName, teamId)
  emitTeamEvent({ type: "team_renamed", team_id: teamId, name: cleanName })
  return getTeam(teamId)!
}

export function deleteTeam(teamId: string, actor: string): void {
  const team = getTeam(teamId)
  if (!team) throw new Error("not_found")
  if (team.owner_customer_id !== actor) throw new Error("only_owner")
  const db = getDb()
  // ON DELETE CASCADE handles team_members / team_invites / team_sessions.
  db.prepare("DELETE FROM teams WHERE id = ?").run(teamId)
  emitTeamEvent({ type: "team_deleted", team_id: teamId })
}

export function getTeam(teamId: string): TeamRow | null {
  return getDb().prepare<TeamRow, [string]>("SELECT * FROM teams WHERE id = ?").get(teamId) ?? null
}

export function getMemberRole(teamId: string, customerId: string): Role | null {
  const r = getDb()
    .prepare<{ role: Role }, [string, string]>(
      "SELECT role FROM team_members WHERE team_id = ? AND customer_id = ?",
    )
    .get(teamId, customerId)
  return r?.role ?? null
}

export function listTeamsForCustomer(customerId: string): Array<TeamRow & { role: Role; member_count: number }> {
  return getDb()
    .prepare<
      TeamRow & { role: Role; member_count: number },
      [string]
    >(
      `SELECT t.*, tm.role AS role,
              (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
        WHERE tm.customer_id = ?
        ORDER BY t.created_at DESC`,
    )
    .all(customerId)
}

export function getTeamDetail(teamId: string, actor: string): TeamDetail | null {
  const team = getTeam(teamId)
  if (!team) return null
  const role = getMemberRole(teamId, actor)
  if (!role) return null

  const db = getDb()
  const members = db
    .prepare<
      TeamMemberRow & {
        display: string | null
        telegram_user_id: number | null
        telegram: string | null
      },
      [string]
    >(
      `SELECT tm.team_id, tm.customer_id, tm.role, tm.added_at,
              COALESCE(c.email, c.telegram, c.id) AS display,
              c.telegram_user_id, c.telegram
         FROM team_members tm
         LEFT JOIN customers c ON c.id = tm.customer_id
        WHERE tm.team_id = ?
        ORDER BY tm.role DESC, tm.added_at ASC`,
    )
    .all(teamId)
  const invites = db
    .prepare<TeamInviteRow, [string]>("SELECT * FROM team_invites WHERE team_id = ? ORDER BY created_at DESC")
    .all(teamId)
  return { team, members, invites, self_role: role }
}

/* ──────────────────────────  Member + invite flow  ────────────────────────── */

export interface AddMemberResult {
  mode: "added" | "invited"
  member?: TeamMemberRow
  invite?: TeamInviteRow
}

/**
 * Admin or owner adds a member by identifier (@handle or email).
 * If the identifier matches an existing customer, add directly.
 * Otherwise, store a pending invite that gets auto-claimed on sign-in.
 */
export function addMemberByIdentifier(
  teamId: string,
  actor: string,
  identifier: string,
): AddMemberResult {
  const role = getMemberRole(teamId, actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  const ident = normalizeIdentifier(identifier)
  const db = getDb()

  // try to match an existing customer by telegram handle (case-insensitive) or email
  const match = db
    .prepare<{ id: string }, [string, string]>(
      `SELECT id FROM customers
        WHERE (telegram IS NOT NULL AND LOWER(telegram) = ?)
           OR (email IS NOT NULL AND LOWER(email) = ?)
        LIMIT 1`,
    )
    .get(ident, ident)

  if (match) {
    if (getMemberRole(teamId, match.id)) throw new Error("already_member")
    db.prepare(
      "INSERT INTO team_members (team_id, customer_id, role, added_at) VALUES (?, ?, 'member', ?)",
    ).run(teamId, match.id, now())
    const member = db
      .prepare<TeamMemberRow, [string, string]>(
        "SELECT * FROM team_members WHERE team_id = ? AND customer_id = ?",
      )
      .get(teamId, match.id)!
    emitTeamEvent({ type: "member_added", team_id: teamId, customer_id: match.id })
    return { mode: "added", member }
  }

  // store pending invite
  const inviteId = newId("inv")
  db.prepare(
    "INSERT INTO team_invites (id, team_id, identifier, role, invited_by, created_at) VALUES (?, ?, ?, 'member', ?, ?)",
  ).run(inviteId, teamId, ident, actor, now())
  const invite = db
    .prepare<TeamInviteRow, [string]>("SELECT * FROM team_invites WHERE id = ?")
    .get(inviteId)!
  return { mode: "invited", invite }
}

export function removeMember(teamId: string, actor: string, customerId: string): void {
  const role = getMemberRole(teamId, actor)
  const team = getTeam(teamId)
  if (!team) throw new Error("not_found")
  if (role !== "owner" && actor !== customerId) throw new Error("forbidden")
  if (customerId === team.owner_customer_id) throw new Error("cannot_remove_owner")
  getDb().prepare("DELETE FROM team_members WHERE team_id = ? AND customer_id = ?").run(teamId, customerId)
  emitTeamEvent({ type: "member_removed", team_id: teamId, customer_id: customerId })
}

/**
 * Owner can promote a member to admin or demote an admin back to member.
 * Owners cannot be demoted (they must transfer ownership first — out of scope
 * for this pass).
 */
export function setMemberRole(
  teamId: string,
  actor: string,
  customerId: string,
  newRole: Role,
): TeamMemberRow {
  const team = getTeam(teamId)
  if (!team) throw new Error("not_found")
  if (team.owner_customer_id !== actor) throw new Error("only_owner")
  if (customerId === team.owner_customer_id) throw new Error("cannot_change_owner_role")
  if (newRole !== "admin" && newRole !== "member" && newRole !== "viewer") throw new Error("invalid_role")
  const current = getMemberRole(teamId, customerId)
  if (!current) throw new Error("not_member")
  getDb().prepare("UPDATE team_members SET role = ? WHERE team_id = ? AND customer_id = ?").run(newRole, teamId, customerId)
  emitTeamEvent({ type: "member_role_changed", team_id: teamId, customer_id: customerId, role: newRole })
  return getDb()
    .prepare<TeamMemberRow, [string, string]>("SELECT * FROM team_members WHERE team_id = ? AND customer_id = ?")
    .get(teamId, customerId)!
}

/**
 * Transfer ownership from the current owner to another existing member. The
 * old owner is demoted to admin so they keep some privileges but can no
 * longer delete the team or re-transfer.
 */
export function transferOwnership(teamId: string, actor: string, newOwnerCustomerId: string): TeamRow {
  const team = getTeam(teamId)
  if (!team) throw new Error("not_found")
  if (team.owner_customer_id !== actor) throw new Error("only_owner")
  if (newOwnerCustomerId === actor) throw new Error("same_owner")
  const targetRole = getMemberRole(teamId, newOwnerCustomerId)
  if (!targetRole) throw new Error("not_member")
  const db = getDb()
  db.transaction(() => {
    db.prepare("UPDATE teams SET owner_customer_id = ? WHERE id = ?").run(newOwnerCustomerId, teamId)
    db.prepare("UPDATE team_members SET role = 'owner' WHERE team_id = ? AND customer_id = ?").run(teamId, newOwnerCustomerId)
    db.prepare("UPDATE team_members SET role = 'admin' WHERE team_id = ? AND customer_id = ?").run(teamId, actor)
  })()
  emitTeamEvent({ type: "member_role_changed", team_id: teamId, customer_id: newOwnerCustomerId, role: "owner" })
  emitTeamEvent({ type: "member_role_changed", team_id: teamId, customer_id: actor, role: "admin" })
  return getTeam(teamId)!
}

export function cancelInvite(teamId: string, actor: string, inviteId: string): void {
  const role = getMemberRole(teamId, actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  getDb().prepare("DELETE FROM team_invites WHERE id = ? AND team_id = ?").run(inviteId, teamId)
}

/**
 * Called at sign-in time: claim any pending invites that match the customer's
 * telegram handle or email, adding them to those teams.
 */
export function claimPendingInvitesForCustomer(customerId: string): { joined: string[] } {
  const db = getDb()
  const customer = db
    .prepare<{ telegram: string | null; email: string | null }, [string]>(
      "SELECT telegram, email FROM customers WHERE id = ?",
    )
    .get(customerId)
  if (!customer) return { joined: [] }
  const identifiers: string[] = []
  if (customer.telegram) identifiers.push(customer.telegram.toLowerCase())
  if (customer.email) identifiers.push(customer.email.toLowerCase())
  if (identifiers.length === 0) return { joined: [] }

  const placeholders = identifiers.map(() => "?").join(",")
  const invites = db
    .prepare<TeamInviteRow, string[]>(`SELECT * FROM team_invites WHERE identifier IN (${placeholders})`)
    .all(...identifiers)
  const joined: string[] = []
  db.transaction(() => {
    for (const inv of invites) {
      if (getMemberRole(inv.team_id, customerId)) {
        db.prepare("DELETE FROM team_invites WHERE id = ?").run(inv.id)
        continue
      }
      db.prepare(
        "INSERT INTO team_members (team_id, customer_id, role, added_at) VALUES (?, ?, ?, ?)",
      ).run(inv.team_id, customerId, inv.role, now())
      db.prepare("DELETE FROM team_invites WHERE id = ?").run(inv.id)
      joined.push(inv.team_id)
    }
  })()
  return { joined }
}

/* ────────────────────────  Invite links  ──────────────────────── */

export interface InviteLinkRow {
  token: string
  team_id: string
  role: Role
  created_by: string
  created_at: number
  expires_at: number | null
  max_uses: number | null
  uses: number
  revoked_at: number | null
}

const INVITE_LINK_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const INVITE_LINK_DEFAULT_MAX_USES = 10

/**
 * Create a shareable invite URL token. Owner/admin only. The returned token
 * is opaque (URL-safe base64) and the caller is expected to embed it in a
 * link like https://crimecode.cc/r/team/<token>.
 */
export function createInviteLink(args: {
  team_id: string
  actor: string
  role?: Role
  ttl_ms?: number | null
  max_uses?: number | null
}): InviteLinkRow {
  const role = getMemberRole(args.team_id, args.actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  const linkRole: Role = args.role ?? "member"
  if (linkRole !== "member" && linkRole !== "viewer") {
    // Refuse to generate links that grant admin/owner — those must go through
    // explicit setMemberRole after the user joins as a regular member.
    throw new Error("invalid_role")
  }
  const token = randomBytes(24).toString("base64url")
  const createdAt = now()
  const expiresAt =
    args.ttl_ms === null ? null : createdAt + (args.ttl_ms ?? INVITE_LINK_DEFAULT_TTL_MS)
  const maxUses = args.max_uses === null ? null : args.max_uses ?? INVITE_LINK_DEFAULT_MAX_USES
  const db = getDb()
  db.prepare(
    `INSERT INTO team_invite_links
       (token, team_id, role, created_by, created_at, expires_at, max_uses, uses)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(token, args.team_id, linkRole, args.actor, createdAt, expiresAt, maxUses)
  return db.prepare<InviteLinkRow, [string]>("SELECT * FROM team_invite_links WHERE token = ?").get(token)!
}

export function listInviteLinks(teamId: string, viewer: string): InviteLinkRow[] {
  const role = getMemberRole(teamId, viewer)
  if (role !== "owner" && role !== "admin") return []
  return getDb()
    .prepare<InviteLinkRow, [string]>(
      "SELECT * FROM team_invite_links WHERE team_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
    )
    .all(teamId)
}

export function revokeInviteLink(teamId: string, actor: string, token: string): void {
  const role = getMemberRole(teamId, actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  getDb()
    .prepare("UPDATE team_invite_links SET revoked_at = ? WHERE token = ? AND team_id = ? AND revoked_at IS NULL")
    .run(now(), token, teamId)
}

/**
 * Public preview — returns just enough info for the redeem page to render
 * the team name + member count + role being granted, without revealing
 * member identities. Token must exist, be unexpired, and have remaining uses.
 */
export function previewInviteLink(token: string): {
  team_id: string
  team_name: string
  role: Role
  member_count: number
  expires_at: number | null
} | null {
  const db = getDb()
  const row = db
    .prepare<InviteLinkRow, [string]>("SELECT * FROM team_invite_links WHERE token = ?")
    .get(token)
  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && row.expires_at < now()) return null
  if (row.max_uses !== null && row.uses >= row.max_uses) return null
  const team = getTeam(row.team_id)
  if (!team) return null
  const memberCount =
    (db
      .prepare<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?")
      .get(row.team_id)?.c ?? 0)
  return {
    team_id: row.team_id,
    team_name: team.name,
    role: row.role,
    member_count: memberCount,
    expires_at: row.expires_at,
  }
}

/**
 * Redeem the token for `customerId`: insert them as a team member with the
 * link's role, increment uses, emit member_added. Returns the team or
 * throws on token/permission errors.
 */
export function redeemInviteLink(args: {
  token: string
  customer_id: string
}): { team: TeamRow; role: Role; already_member: boolean } {
  const db = getDb()
  const row = db
    .prepare<InviteLinkRow, [string]>("SELECT * FROM team_invite_links WHERE token = ?")
    .get(args.token)
  if (!row) throw new Error("invalid_token")
  if (row.revoked_at) throw new Error("token_revoked")
  if (row.expires_at && row.expires_at < now()) throw new Error("token_expired")
  if (row.max_uses !== null && row.uses >= row.max_uses) throw new Error("token_exhausted")

  const team = getTeam(row.team_id)
  if (!team) throw new Error("team_not_found")

  const existingRole = getMemberRole(row.team_id, args.customer_id)
  if (existingRole) {
    return { team, role: existingRole, already_member: true }
  }

  db.transaction(() => {
    db.prepare(
      "INSERT INTO team_members (team_id, customer_id, role, added_at) VALUES (?, ?, ?, ?)",
    ).run(row.team_id, args.customer_id, row.role, now())
    db.prepare("UPDATE team_invite_links SET uses = uses + 1 WHERE token = ?").run(args.token)
  })()

  emitTeamEvent({ type: "member_added", team_id: row.team_id, customer_id: args.customer_id })
  return { team, role: row.role, already_member: false }
}

/* ──────────────────────────  Live sessions  ────────────────────────── */

export function createTeamSession(opts: { team_id: string; host: string; title: string; state?: unknown }): TeamSessionRow {
  const role = getMemberRole(opts.team_id, opts.host)
  if (!role) throw new Error("not_member")
  const id = newId("ts")
  const db = getDb()
  db.prepare(
    "INSERT INTO team_sessions (id, team_id, host_customer_id, title, state, created_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    opts.team_id,
    opts.host,
    opts.title.slice(0, 200),
    opts.state ? JSON.stringify(opts.state).slice(0, 16_000) : null,
    now(),
    now(),
  )
  emitTeamEvent({
    type: "session_started",
    team_id: opts.team_id,
    session_id: id,
    host: opts.host,
    title: opts.title.slice(0, 200),
  })
  return db.prepare<TeamSessionRow, [string]>("SELECT * FROM team_sessions WHERE id = ?").get(id)!
}

/**
 * Verify that `sessionId` is an active session belonging to `teamId`.
 * Returns true only if the row exists, is in the named team, and hasn't
 * been ended. Used by the cursor-broadcast endpoint to make sure a stale
 * session_id from another team can't be used to leak cursor packets across
 * teams via /sessions/:sid/cursor.
 */
export function isActiveSessionInTeam(teamId: string, sessionId: string): boolean {
  const cutoff = now() - 90
  const row = getDb()
    .prepare<{ id: string }, [string, string, number]>(
      `SELECT id FROM team_sessions
        WHERE id = ?
          AND team_id = ?
          AND ended_at IS NULL
          AND last_heartbeat_at >= ?`,
    )
    .get(sessionId, teamId, cutoff)
  return !!row
}

export function listActiveSessions(teamId: string, viewer: string): TeamSessionRow[] {
  if (!getMemberRole(teamId, viewer)) return []
  // Sessions that haven't heartbeated in >90s are considered stale.
  const cutoff = now() - 90
  return getDb()
    .prepare<TeamSessionRow, [string, number]>(
      `SELECT * FROM team_sessions
        WHERE team_id = ?
          AND ended_at IS NULL
          AND last_heartbeat_at >= ?
        ORDER BY created_at DESC`,
    )
    .all(teamId, cutoff)
}

export function heartbeatSession(sessionId: string, actor: string, state?: unknown): TeamSessionRow | null {
  const db = getDb()
  const row = db
    .prepare<TeamSessionRow, [string]>("SELECT * FROM team_sessions WHERE id = ?")
    .get(sessionId)
  if (!row || row.host_customer_id !== actor) return null
  // Refuse to refresh a session that's already been ended. Without this
  // guard a heartbeat that races endSession() can clobber the row's
  // last_heartbeat_at timestamp on a "dead" session, leaving stale state
  // in the DB and confusing downstream tooling that expects ended rows
  // to stop changing.
  if (row.ended_at !== null) return null
  const stateJson = state !== undefined ? JSON.stringify(state).slice(0, 16_000) : null
  const r = db
    .prepare(
      "UPDATE team_sessions SET last_heartbeat_at = ?, state = COALESCE(?, state) WHERE id = ? AND ended_at IS NULL",
    )
    .run(now(), stateJson, sessionId)
  if (r.changes === 0) return null
  emitTeamEvent({ type: "session_heartbeat", team_id: row.team_id, session_id: sessionId })
  // When the host pushed a fresh state blob alongside the heartbeat we
  // emit a separate event so guests that follow this host can react
  // *immediately* instead of waiting for the next listSessions() refresh
  // — that's how the "follow my workspace" UX gets live.
  if (state !== undefined) {
    emitTeamEvent({
      type: "session_state",
      team_id: row.team_id,
      session_id: sessionId,
      host_customer_id: row.host_customer_id,
      state,
      ts: now(),
    })
  }
  return db.prepare<TeamSessionRow, [string]>("SELECT * FROM team_sessions WHERE id = ?").get(sessionId) ?? null
}

/**
 * Read the most recent `state` blob a host pushed for a live session.
 * Returns null if the session doesn't exist, has ended, or the viewer
 * isn't a team member. Used by guests on first attach so they don't
 * have to wait for the next state push to know what the host is on.
 */
export function getSessionState(
  teamId: string,
  sessionId: string,
  viewer: string,
): { state: unknown; host_customer_id: string; last_heartbeat_at: number } | null {
  if (!getMemberRole(teamId, viewer)) return null
  const row = getDb()
    .prepare<TeamSessionRow, [string]>("SELECT * FROM team_sessions WHERE id = ?")
    .get(sessionId)
  if (!row || row.team_id !== teamId || row.ended_at !== null) return null
  let parsed: unknown = null
  if (row.state) {
    try {
      parsed = JSON.parse(row.state)
    } catch {
      parsed = null
    }
  }
  return { state: parsed, host_customer_id: row.host_customer_id, last_heartbeat_at: row.last_heartbeat_at }
}

/**
 * Sweep team_sessions: any row that hasn't heartbeated in `staleSec`
 * seconds and is still missing `ended_at` gets stamped as ended (with
 * `ended_at = now`). Emits `session_ended` for each so subscribers
 * (web app live-sessions list, telegram bot, …) tear down their UI.
 *
 * Called by the background reaper started in `startSessionReaper()`.
 * Safe to call concurrently — every UPDATE filters on `ended_at IS NULL`
 * so a second sweeper is a no-op.
 */
export function reapStaleSessions(staleSec: number = 60): number {
  const db = getDb()
  const cutoff = now() - staleSec
  const stale = db
    .prepare<{ id: string; team_id: string }, [number]>(
      "SELECT id, team_id FROM team_sessions WHERE ended_at IS NULL AND last_heartbeat_at < ?",
    )
    .all(cutoff)
  if (stale.length === 0) return 0
  let reaped = 0
  for (const s of stale) {
    const r = db
      .prepare("UPDATE team_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
      .run(now(), s.id)
    if (r.changes > 0) {
      emitTeamEvent({ type: "session_ended", team_id: s.team_id, session_id: s.id })
      reaped += 1
    }
  }
  return reaped
}

/**
 * Resolve the best display name we have for a customer (telegram @handle
 * preferred, then username/email, then id). Used by chat to capture the
 * author label at send-time.
 */
export function getCustomerDisplay(customerId: string): string | null {
  const row = getDb()
    .prepare<{ display: string | null }, [string]>(
      "SELECT COALESCE(telegram, email, id) AS display FROM customers WHERE id = ?",
    )
    .get(customerId)
  return row?.display ?? null
}

/* ──────────────────────────  Team chat  ────────────────────────── */

export interface TeamChatRow {
  id: number
  team_id: string
  customer_id: string
  author_name: string | null
  text: string
  ts: number
  /** R2-hosted URL for an image/PDF attached to this message, or null. */
  attachment_url: string | null
  /** MIME type of the attachment (e.g. image/png, application/pdf). */
  attachment_type: string | null
  /** Size in bytes of the attachment, capped at 10 MB on upload. */
  attachment_size: number | null
  /** Original file name (display only — never used for filesystem ops). */
  attachment_name: string | null
}

export interface ChatAttachment {
  url: string
  type: string
  size: number
  name: string
}

const CHAT_RETENTION = 200 // keep at most N rows per team — dropped on insert

/**
 * Persist a chat message and emit a real-time event. Validates length,
 * trims whitespace, and rejects empty / oversized messages. The author's
 * `display` name (Telegram @handle when available, otherwise the customer
 * id) is captured at write time so the UI can render the right label even
 * after a member changes their handle.
 */
export function postChatMessage(args: {
  team_id: string
  author: string
  author_name: string | null
  text: string
  attachment?: ChatAttachment | null
}): TeamChatRow | null {
  // Viewers (read-only role) cannot post chat — only owner/admin/member can.
  if (!canWrite(getMemberRole(args.team_id, args.author))) return null
  const text = args.text.trim()
  // Allow empty text when there's an attachment — image/file-only messages
  // are a normal pattern in chat UIs.
  if (!text && !args.attachment) return null
  if (text.length > 2000) return null

  const att = args.attachment ?? null

  const db = getDb()
  const ts = now()
  const result = db
    .prepare(
      `INSERT INTO team_chat_messages
         (team_id, customer_id, author_name, text, ts,
          attachment_url, attachment_type, attachment_size, attachment_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.team_id,
      args.author,
      args.author_name,
      text,
      ts,
      att?.url ?? null,
      att?.type ?? null,
      att?.size ?? null,
      att?.name ?? null,
    )
  const id = Number(result.lastInsertRowid)

  // Prune old rows for this team so the table can't grow without bound.
  // SQLite doesn't have a "DELETE … OFFSET" so we bound by id.
  db.prepare(
    `DELETE FROM team_chat_messages
       WHERE team_id = ?
         AND id NOT IN (
           SELECT id FROM team_chat_messages WHERE team_id = ? ORDER BY id DESC LIMIT ?
         )`,
  ).run(args.team_id, args.team_id, CHAT_RETENTION)

  const row: TeamChatRow = {
    id,
    team_id: args.team_id,
    customer_id: args.author,
    author_name: args.author_name,
    text,
    ts,
    attachment_url: att?.url ?? null,
    attachment_type: att?.type ?? null,
    attachment_size: att?.size ?? null,
    attachment_name: att?.name ?? null,
  }
  emitTeamEvent({
    type: "chat_message",
    team_id: args.team_id,
    message_id: id,
    customer_id: args.author,
    author_name: args.author_name,
    text,
    ts,
    attachment_url: att?.url ?? null,
    attachment_type: att?.type ?? null,
    attachment_size: att?.size ?? null,
    attachment_name: att?.name ?? null,
  })
  return row
}

/**
 * Most-recent N messages for a team, oldest-first so the UI can render
 * a scrollable history without flipping the array.
 */
export function listChatMessages(teamId: string, viewer: string, limit = 50): TeamChatRow[] {
  if (!getMemberRole(teamId, viewer)) return []
  const cap = Math.min(Math.max(1, limit), 200)
  return getDb()
    .prepare<TeamChatRow, [string, number]>(
      `SELECT id, team_id, customer_id, author_name, text, ts,
              attachment_url, attachment_type, attachment_size, attachment_name
         FROM team_chat_messages WHERE team_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(teamId, cap)
    .reverse()
}

/**
 * Lightweight typing indicator — emitted-only, not persisted. The client
 * keeps a per-customer expiry timer to fade the indicator out after ~3 s
 * of silence.
 */
export function broadcastTyping(args: { team_id: string; author: string; author_name: string | null }): void {
  if (!getMemberRole(args.team_id, args.author)) return
  emitTeamEvent({
    type: "chat_typing",
    team_id: args.team_id,
    customer_id: args.author,
    author_name: args.author_name,
  })
}

// ── Read receipts ─────────────────────────────────────────────────────
// Per-(team, customer) high-water-mark of the last chat message acknowledged.
// Updated on POST /chat/read; broadcast on the SSE bus so peers can render
// "seen by N" markers without polling.

export interface TeamChatReadRow {
  team_id: string
  customer_id: string
  last_read_message_id: number
  updated_at: number
}

export function markChatRead(args: { team_id: string; customer_id: string; message_id: number }): TeamChatReadRow | null {
  if (!getMemberRole(args.team_id, args.customer_id)) return null
  if (!Number.isFinite(args.message_id) || args.message_id <= 0) return null
  const db = getDb()
  const ts = now()
  // Upsert with high-water-mark semantics: never decrease the existing value.
  db.prepare(
    `INSERT INTO team_chat_reads (team_id, customer_id, last_read_message_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, customer_id) DO UPDATE SET
       last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
       updated_at = excluded.updated_at`,
  ).run(args.team_id, args.customer_id, args.message_id, ts)
  const row = db
    .prepare<TeamChatReadRow, [string, string]>(
      "SELECT team_id, customer_id, last_read_message_id, updated_at FROM team_chat_reads WHERE team_id = ? AND customer_id = ?",
    )
    .get(args.team_id, args.customer_id)
  if (!row) return null
  emitTeamEvent({
    type: "chat_read",
    team_id: args.team_id,
    customer_id: args.customer_id,
    last_read_message_id: row.last_read_message_id,
    ts: row.updated_at,
  })
  return row
}

export function listChatReads(teamId: string, viewer: string): TeamChatReadRow[] {
  if (!getMemberRole(teamId, viewer)) return []
  const db = getDb()
  return db
    .prepare<TeamChatReadRow, [string]>(
      "SELECT team_id, customer_id, last_read_message_id, updated_at FROM team_chat_reads WHERE team_id = ?",
    )
    .all(teamId)
}

// ── Team agents ───────────────────────────────────────────────────────
// Shared system-prompt templates that any team member can invoke with
// `@<slug>` in chat or in the AI prompt. Owner/admin define them; members
// invoke. The system prompt is prepended to the user's message before
// the AI call — invocation happens client-side so the local quota is
// charged, not the central license server's.

export interface TeamAgentRow {
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

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

function normalizeSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

export function listTeamAgents(teamId: string, viewer: string): TeamAgentRow[] {
  if (!getMemberRole(teamId, viewer)) return []
  const db = getDb()
  return db
    .prepare<TeamAgentRow, [string]>(
      `SELECT id, team_id, slug, display_name, system_prompt, model, description,
              created_by, created_at, updated_at
       FROM team_agents WHERE team_id = ? ORDER BY display_name COLLATE NOCASE`,
    )
    .all(teamId)
}

export function createTeamAgent(args: {
  team_id: string
  actor: string
  slug: string
  display_name: string
  system_prompt: string
  model?: string | null
  description?: string | null
}): TeamAgentRow {
  const role = getMemberRole(args.team_id, args.actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  const slug = normalizeSlug(args.slug)
  if (!SLUG_RE.test(slug)) throw new Error("invalid_slug")
  const display = args.display_name.trim().slice(0, 80)
  if (!display) throw new Error("invalid_display_name")
  const prompt = args.system_prompt.trim()
  if (!prompt) throw new Error("invalid_system_prompt")
  if (prompt.length > 8000) throw new Error("system_prompt_too_long")
  const ts = now()
  const id = `ag_${randomBytes(9).toString("base64url")}`
  const db = getDb()
  try {
    db.prepare(
      `INSERT INTO team_agents (id, team_id, slug, display_name, system_prompt, model, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, args.team_id, slug, display, prompt, args.model ?? null, args.description ?? null, args.actor, ts, ts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("UNIQUE")) throw new Error("slug_taken")
    throw err
  }
  const row = db
    .prepare<TeamAgentRow, [string]>("SELECT * FROM team_agents WHERE id = ?")
    .get(id)
  if (!row) throw new Error("agent_not_created")
  return row
}

export function updateTeamAgent(args: {
  team_id: string
  agent_id: string
  actor: string
  display_name?: string
  system_prompt?: string
  model?: string | null
  description?: string | null
}): TeamAgentRow {
  const role = getMemberRole(args.team_id, args.actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  const db = getDb()
  const existing = db
    .prepare<TeamAgentRow, [string, string]>("SELECT * FROM team_agents WHERE id = ? AND team_id = ?")
    .get(args.agent_id, args.team_id)
  if (!existing) throw new Error("agent_not_found")
  const display = args.display_name === undefined ? existing.display_name : args.display_name.trim().slice(0, 80)
  if (!display) throw new Error("invalid_display_name")
  const prompt = args.system_prompt === undefined ? existing.system_prompt : args.system_prompt.trim()
  if (!prompt) throw new Error("invalid_system_prompt")
  if (prompt.length > 8000) throw new Error("system_prompt_too_long")
  const model = args.model === undefined ? existing.model : args.model
  const description = args.description === undefined ? existing.description : args.description
  const ts = now()
  db.prepare(
    `UPDATE team_agents SET display_name = ?, system_prompt = ?, model = ?, description = ?, updated_at = ?
     WHERE id = ? AND team_id = ?`,
  ).run(display, prompt, model, description, ts, args.agent_id, args.team_id)
  const row = db
    .prepare<TeamAgentRow, [string]>("SELECT * FROM team_agents WHERE id = ?")
    .get(args.agent_id)
  if (!row) throw new Error("agent_not_found")
  return row
}

export function deleteTeamAgent(args: { team_id: string; agent_id: string; actor: string }): boolean {
  const role = getMemberRole(args.team_id, args.actor)
  if (role !== "owner" && role !== "admin") throw new Error("forbidden")
  const db = getDb()
  const r = db
    .prepare("DELETE FROM team_agents WHERE id = ? AND team_id = ?")
    .run(args.agent_id, args.team_id)
  return r.changes > 0
}

export function endSession(sessionId: string, actor: string): boolean {
  const db = getDb()
  const row = db
    .prepare<TeamSessionRow, [string]>("SELECT * FROM team_sessions WHERE id = ?")
    .get(sessionId)
  if (!row) return false
  if (row.host_customer_id !== actor) {
    const role = getMemberRole(row.team_id, actor)
    if (role !== "owner") return false
  }
  db.prepare("UPDATE team_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(now(), sessionId)
  emitTeamEvent({ type: "session_ended", team_id: row.team_id, session_id: sessionId })
  return true
}
