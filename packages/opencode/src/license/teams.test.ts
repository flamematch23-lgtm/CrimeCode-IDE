import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Tests for the teams store.
 *
 * Uses a real SQLite file in tmp because the store module caches a
 * DB handle at module scope. Between tests we TRUNCATE every table so
 * each case starts from a known empty state.
 */

const tmpRoot = mkdtempSync(join(tmpdir(), "crimecode-teams-"))
const dbPath = join(tmpRoot, "licenses.db")

const prevDb = process.env.LICENSE_DB_PATH
const prevSecret = process.env.LICENSE_HMAC_SECRET

beforeAll(() => {
  process.env.LICENSE_DB_PATH = dbPath
  process.env.LICENSE_HMAC_SECRET = "teams-test-secret-long-enough-to-pass-32-char-check-aaaaaaa"
})

afterAll(() => {
  try {
    // The DB handle is still open from the store singleton. Best-effort
    // cleanup — on Windows the file may stay locked a moment longer, so
    // swallow EBUSY.
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (prevDb === undefined) delete process.env.LICENSE_DB_PATH
  else process.env.LICENSE_DB_PATH = prevDb
  if (prevSecret === undefined) delete process.env.LICENSE_HMAC_SECRET
  else process.env.LICENSE_HMAC_SECRET = prevSecret
})

import * as dbMod from "./db"
import * as store from "./store"
import * as teams from "./teams"

beforeEach(() => {
  const db = dbMod.getDb()
  // Order matters — children first to respect FK.
  db.exec("DELETE FROM team_sessions")
  db.exec("DELETE FROM team_invites")
  db.exec("DELETE FROM team_members")
  db.exec("DELETE FROM teams")
  db.exec("DELETE FROM payment_offers")
  db.exec("DELETE FROM licenses")
  db.exec("DELETE FROM orders")
  db.exec("DELETE FROM sync_kv")
  db.exec("DELETE FROM auth_sessions")
  db.exec("DELETE FROM auth_pins")
  db.exec("DELETE FROM customers")
  db.exec("DELETE FROM audit")
})

function makeCustomer(telegram: string, user_id?: number) {
  return store.findOrCreateCustomerByTelegram({
    telegram,
    telegram_user_id: user_id ?? null,
  })
}

describe("license/teams", () => {
  describe("createTeam", () => {
    test("creates the team and auto-adds the owner", () => {
      const owner = makeCustomer("@alice", 111)
      const team = teams.createTeam(owner.id, "Alpha")
      expect(team.name).toBe("Alpha")
      expect(team.owner_customer_id).toBe(owner.id)
      expect(teams.getMemberRole(team.id, owner.id)).toBe("owner")
    })

    test("rejects empty and over-long names", () => {
      const owner = makeCustomer("@alice")
      expect(() => teams.createTeam(owner.id, "")).toThrow("invalid_name")
      expect(() => teams.createTeam(owner.id, " ".repeat(10))).toThrow("invalid_name")
      expect(() => teams.createTeam(owner.id, "a".repeat(81))).toThrow("invalid_name")
    })
  })

  describe("addMemberByIdentifier", () => {
    test("adds an existing customer directly when telegram handle matches", () => {
      const owner = makeCustomer("@alice", 111)
      const target = makeCustomer("@bob", 222)
      const team = teams.createTeam(owner.id, "Alpha")
      const r = teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      expect(r.mode).toBe("added")
      expect(r.member?.customer_id).toBe(target.id)
      expect(teams.getMemberRole(team.id, target.id)).toBe("member")
    })

    test("handle matching is case-insensitive", () => {
      const owner = makeCustomer("@alice")
      makeCustomer("@Bob")
      const team = teams.createTeam(owner.id, "Alpha")
      const r = teams.addMemberByIdentifier(team.id, owner.id, "@BOB")
      expect(r.mode).toBe("added")
    })

    test("stores a pending invite when no customer matches yet", () => {
      const owner = makeCustomer("@alice")
      const team = teams.createTeam(owner.id, "Alpha")
      const r = teams.addMemberByIdentifier(team.id, owner.id, "@ghost")
      expect(r.mode).toBe("invited")
      expect(r.invite?.identifier).toBe("@ghost")
      const detail = teams.getTeamDetail(team.id, owner.id)
      expect(detail?.invites.length).toBe(1)
    })

    test("rejects non-admins", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      expect(() => teams.addMemberByIdentifier(team.id, member.id, "@carol")).toThrow("forbidden")
    })

    test("rejects duplicate members", () => {
      const owner = makeCustomer("@alice")
      makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      expect(() => teams.addMemberByIdentifier(team.id, owner.id, "@bob")).toThrow("already_member")
    })

    test("admin can add members", () => {
      const owner = makeCustomer("@alice")
      const admin = makeCustomer("@bob")
      makeCustomer("@carol")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      teams.setMemberRole(team.id, owner.id, admin.id, "admin")
      const r = teams.addMemberByIdentifier(team.id, admin.id, "@carol")
      expect(r.mode).toBe("added")
    })
  })

  describe("setMemberRole", () => {
    test("owner promotes member to admin", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      const updated = teams.setMemberRole(team.id, owner.id, member.id, "admin")
      expect(updated.role).toBe("admin")
    })

    test("owner demotes admin back to member", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      teams.setMemberRole(team.id, owner.id, member.id, "admin")
      const back = teams.setMemberRole(team.id, owner.id, member.id, "member")
      expect(back.role).toBe("member")
    })

    test("admin cannot change roles", () => {
      const owner = makeCustomer("@alice")
      const admin = makeCustomer("@bob")
      const member = makeCustomer("@carol")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      teams.addMemberByIdentifier(team.id, owner.id, "@carol")
      teams.setMemberRole(team.id, owner.id, admin.id, "admin")
      expect(() => teams.setMemberRole(team.id, admin.id, member.id, "admin")).toThrow("only_owner")
    })

    test("rejects promoting to invalid role", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      expect(() => teams.setMemberRole(team.id, owner.id, member.id, "owner" as never)).toThrow("invalid_role")
    })

    test("rejects changing the owner's role", () => {
      const owner = makeCustomer("@alice")
      const team = teams.createTeam(owner.id, "Alpha")
      expect(() => teams.setMemberRole(team.id, owner.id, owner.id, "admin")).toThrow("cannot_change_owner_role")
    })
  })

  describe("transferOwnership", () => {
    test("swaps owner and demotes the old owner to admin", () => {
      const owner = makeCustomer("@alice")
      const target = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      const updated = teams.transferOwnership(team.id, owner.id, target.id)
      expect(updated.owner_customer_id).toBe(target.id)
      expect(teams.getMemberRole(team.id, target.id)).toBe("owner")
      expect(teams.getMemberRole(team.id, owner.id)).toBe("admin")
    })

    test("rejects transfer by non-owner", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      expect(() => teams.transferOwnership(team.id, member.id, member.id)).toThrow("only_owner")
    })

    test("rejects transfer to self", () => {
      const owner = makeCustomer("@alice")
      const team = teams.createTeam(owner.id, "Alpha")
      expect(() => teams.transferOwnership(team.id, owner.id, owner.id)).toThrow("same_owner")
    })

    test("rejects transfer to a non-member", () => {
      const owner = makeCustomer("@alice")
      const outsider = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      expect(() => teams.transferOwnership(team.id, owner.id, outsider.id)).toThrow("not_member")
    })
  })

  describe("removeMember", () => {
    test("owner can remove a member", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      teams.removeMember(team.id, owner.id, member.id)
      expect(teams.getMemberRole(team.id, member.id)).toBeNull()
    })

    test("member can remove themself (leave)", () => {
      const owner = makeCustomer("@alice")
      const member = makeCustomer("@bob")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      teams.removeMember(team.id, member.id, member.id)
      expect(teams.getMemberRole(team.id, member.id)).toBeNull()
    })

    test("owner cannot remove themself", () => {
      const owner = makeCustomer("@alice")
      const team = teams.createTeam(owner.id, "Alpha")
      expect(() => teams.removeMember(team.id, owner.id, owner.id)).toThrow("cannot_remove_owner")
    })

    test("non-owner cannot remove someone else", () => {
      const owner = makeCustomer("@alice")
      const a = makeCustomer("@bob")
      const b = makeCustomer("@carol")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob")
      teams.addMemberByIdentifier(team.id, owner.id, "@carol")
      expect(() => teams.removeMember(team.id, a.id, b.id)).toThrow("forbidden")
    })
  })

  describe("claimPendingInvitesForCustomer", () => {
    test("auto-joins the customer at sign-in when their handle matches an invite", () => {
      const owner = makeCustomer("@alice")
      const team = teams.createTeam(owner.id, "Alpha")
      teams.addMemberByIdentifier(team.id, owner.id, "@bob") // pending, no customer yet
      const bob = makeCustomer("@bob", 222)
      const { joined } = teams.claimPendingInvitesForCustomer(bob.id)
      expect(joined).toContain(team.id)
      expect(teams.getMemberRole(team.id, bob.id)).toBe("member")
    })

    test("does nothing when no matching invite exists", () => {
      const alice = makeCustomer("@alice")
      const { joined } = teams.claimPendingInvitesForCustomer(alice.id)
      expect(joined).toEqual([])
    })
  })
})
