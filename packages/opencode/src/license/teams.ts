import { randomBytes } from "node:crypto"
import { getDb } from "./db"
import { emitTeamEvent } from "./team-events"

type Role = "owner" | "admin" | "member"

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
  if (newRole !== "admin" && newRole !== "member") throw new Error("invalid_role")
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
  const r = db
    .prepare(
      "UPDATE team_sessions SET last_heartbeat_at = ?, state = COALESCE(?, state) WHERE id = ? AND ended_at IS NULL",
    )
    .run(now(), state !== undefined ? JSON.stringify(state).slice(0, 16_000) : null, sessionId)
  if (r.changes === 0) return null
  emitTeamEvent({ type: "session_heartbeat", team_id: row.team_id, session_id: sessionId })
  return db.prepare<TeamSessionRow, [string]>("SELECT * FROM team_sessions WHERE id = ?").get(sessionId) ?? null
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
