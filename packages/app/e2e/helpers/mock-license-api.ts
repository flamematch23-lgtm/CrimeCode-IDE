import type { Page, Route } from "@playwright/test"

/**
 * In-process mock for the CrimeCode licensing API.
 *
 * Installs Playwright route handlers on a page so every /license/* call
 * resolves against a small in-memory database. Flow tests drive the
 * simulation by calling the helper's methods (e.g. `simulateBotClaimsPin`)
 * instead of hitting a real backend.
 *
 * Everything is self-contained per Page so multiple tests can run in
 * parallel without leaking state. Call `install()` once in a test, or
 * the returned `attach(page)` inside a `beforeEach` to re-use one harness
 * across related tests.
 */

export interface MockCustomer {
  id: string
  telegram: string
  telegram_user_id: number
}

export interface MockPin {
  pin: string
  bot_url: string
  expires_at: number
  /** Set when the bot (simulation) has claimed the PIN for a customer. */
  claimed_by: MockCustomer | null
}

export interface MockSession {
  token: string
  customer_id: string
  telegram_user_id: number
  expires_at: number
}

export interface MockLicense {
  id: string
  customer_id: string
  interval: "monthly" | "annual" | "lifetime"
  issued_at: number
  expires_at: number | null
  token: string
  token_sig: string
  revoked: boolean
}

export interface MockTeam {
  id: string
  name: string
  owner_customer_id: string
  created_at: number
  members: Array<{ customer_id: string; role: "owner" | "admin" | "member" }>
  invites: Array<{ id: string; identifier: string; role: string }>
}

let seq = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`

export class MockLicenseApi {
  // Server state
  private customers = new Map<string, MockCustomer>()
  private pins = new Map<string, MockPin>()
  private sessions = new Map<string, MockSession>() // keyed by token
  private licenses = new Map<string, MockLicense>()
  private teams = new Map<string, MockTeam>()

  // Tracking so tests can assert on request shape.
  public recorded: Array<{ method: string; url: string; body?: unknown }> = []

  /** Seed a ready-made customer that "the bot" will use when claiming PINs. */
  seedCustomer(id = "cus_alice", telegram = "@alice", telegram_user_id = 111): MockCustomer {
    const c: MockCustomer = { id, telegram, telegram_user_id }
    this.customers.set(id, c)
    return c
  }

  /** Move a pending PIN into the "claimed" state so the next poll returns ok. */
  simulateBotClaimsPin(pin: string, customer: MockCustomer) {
    const row = this.pins.get(pin)
    if (!row) throw new Error(`unknown pin: ${pin}`)
    row.claimed_by = customer
  }

  /** Grant the given customer an active license for the given plan. */
  grantLicense(
    customer: MockCustomer,
    interval: MockLicense["interval"],
    ttlSeconds?: number,
  ): MockLicense {
    const id = nextId("lic")
    const issued_at = Math.floor(Date.now() / 1000)
    const expires_at = interval === "lifetime" ? null : issued_at + (ttlSeconds ?? 30 * 86400)
    const token = `CC2-mock.${id}`
    const lic: MockLicense = {
      id,
      customer_id: customer.id,
      interval,
      issued_at,
      expires_at,
      token,
      token_sig: id,
      revoked: false,
    }
    this.licenses.set(id, lic)
    return lic
  }

  /** Install all /license/* route handlers on the given page. */
  async install(page: Page) {
    const match = "**/license/**"

    await page.route(match, async (route, request) => {
      const url = new URL(request.url())
      const path = url.pathname
      const method = request.method()
      const rawBody = request.postData()
      let body: unknown = null
      if (rawBody) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = rawBody
        }
      }
      this.recorded.push({ method, url: path, body })
      try {
        await this.dispatch(route, method, path, request.headers(), body, url)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: msg }) })
      }
    })

    // /global/config is called by the AuthGate to verify credentials — just
    // return an empty object so the Self-hosted tab's verification passes
    // in tests that need it.
    await page.route("**/global/config", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    )
  }

  private async dispatch(
    route: Route,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
    url: URL,
  ) {
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })

    // ── Auth flow ────────────────────────────────────────────────
    if (method === "POST" && path.endsWith("/license/auth/start")) {
      const pin = "ABCDEF" + Math.floor(Math.random() * 100)
      const bot_url = `https://t.me/CrimeCodeSub_bot?start=auth_${pin}`
      const expires_at = Math.floor(Date.now() / 1000) + 600
      this.pins.set(pin, { pin, bot_url, expires_at, claimed_by: null })
      return json(200, { pin, bot_url, expires_at })
    }

    const pollMatch = path.match(/\/license\/auth\/poll\/([^/]+)$/)
    if (method === "GET" && pollMatch) {
      const pin = decodeURIComponent(pollMatch[1])
      const row = this.pins.get(pin)
      if (!row) return json(200, { status: "unknown" })
      const now = Math.floor(Date.now() / 1000)
      if (!row.claimed_by && row.expires_at <= now) return json(200, { status: "expired" })
      if (!row.claimed_by) return json(200, { status: "pending" })
      // Issue a session.
      const token = "S1.mock." + row.claimed_by.id
      const exp = Math.floor(Date.now() / 1000) + 30 * 86400
      this.sessions.set(token, {
        token,
        customer_id: row.claimed_by.id,
        telegram_user_id: row.claimed_by.telegram_user_id,
        expires_at: exp,
      })
      this.pins.delete(pin)
      return json(200, { status: "ok", token, exp, customer_id: row.claimed_by.id })
    }

    // Bearer-authenticated endpoints
    const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "")
    const session = this.sessions.get(bearer)

    if (method === "GET" && path.endsWith("/license/auth/me")) {
      if (!session) return json(401, { error: "unauthorized" })
      return json(200, {
        customer_id: session.customer_id,
        telegram_user_id: session.telegram_user_id,
        session_id: "sid_mock",
        expires_at: session.expires_at,
        sessions: [],
      })
    }

    if (method === "POST" && path.endsWith("/license/auth/logout")) {
      if (!session) return json(401, { error: "unauthorized" })
      this.sessions.delete(bearer)
      return json(200, { ok: true })
    }

    // ── Validate ────────────────────────────────────────────────
    if (method === "POST" && path.endsWith("/license/validate")) {
      const token = (body as { token?: string } | null)?.token ?? ""
      const found = Array.from(this.licenses.values()).find((l) => l.token === token)
      if (!found) return json(200, { status: "unknown" })
      if (found.revoked) return json(200, { status: "revoked" })
      const now = Math.floor(Date.now() / 1000)
      if (found.expires_at != null && found.expires_at <= now)
        return json(200, { status: "expired", expires_at: found.expires_at })
      return json(200, {
        status: "valid",
        expires_at: found.expires_at,
        interval: found.interval,
        issued_at: found.issued_at,
      })
    }

    // ── Teams ────────────────────────────────────────────────
    if (!session && path.startsWith("/license/teams")) {
      return json(401, { error: "unauthorized" })
    }

    if (method === "GET" && path === "/license/teams") {
      const mine = Array.from(this.teams.values()).filter((t) =>
        t.members.some((m) => m.customer_id === session!.customer_id),
      )
      return json(200, {
        teams: mine.map((t) => ({
          ...t,
          role: t.members.find((m) => m.customer_id === session!.customer_id)!.role,
          member_count: t.members.length,
        })),
      })
    }

    if (method === "POST" && path === "/license/teams") {
      const name = (body as { name?: string } | null)?.name?.trim()
      if (!name) return json(400, { error: "invalid_name" })
      const id = nextId("team")
      const team: MockTeam = {
        id,
        name,
        owner_customer_id: session!.customer_id,
        created_at: Math.floor(Date.now() / 1000),
        members: [{ customer_id: session!.customer_id, role: "owner" }],
        invites: [],
      }
      this.teams.set(id, team)
      return json(200, { team })
    }

    const teamIdMatch = path.match(/\/license\/teams\/([^/]+)/)
    if (teamIdMatch) {
      const teamId = decodeURIComponent(teamIdMatch[1])
      const team = this.teams.get(teamId)
      if (!team) return json(404, { error: "not_found" })
      const selfRole = team.members.find((m) => m.customer_id === session!.customer_id)?.role
      if (!selfRole) return json(403, { error: "forbidden" })

      if (method === "GET" && path === `/license/teams/${teamId}`) {
        return json(200, {
          team,
          members: team.members.map((m) => ({
            ...m,
            team_id: team.id,
            added_at: team.created_at,
            display: this.customers.get(m.customer_id)?.telegram ?? m.customer_id,
            telegram_user_id: this.customers.get(m.customer_id)?.telegram_user_id ?? null,
            telegram: this.customers.get(m.customer_id)?.telegram ?? null,
          })),
          invites: team.invites.map((i) => ({
            ...i,
            team_id: team.id,
            invited_by: session!.customer_id,
            created_at: team.created_at,
          })),
          self_role: selfRole,
        })
      }

      if (method === "POST" && path === `/license/teams/${teamId}/members`) {
        if (selfRole !== "owner" && selfRole !== "admin") return json(403, { error: "forbidden" })
        const identifier = (body as { identifier?: string } | null)?.identifier?.trim().toLowerCase()
        if (!identifier) return json(400, { error: "missing_identifier" })
        const match = Array.from(this.customers.values()).find(
          (c) => c.telegram.toLowerCase() === identifier,
        )
        if (match) {
          if (team.members.some((m) => m.customer_id === match.id))
            return json(409, { error: "already_member" })
          team.members.push({ customer_id: match.id, role: "member" })
          return json(200, { mode: "added" })
        }
        const invite = { id: nextId("inv"), identifier, role: "member" as const }
        team.invites.push(invite)
        return json(200, { mode: "invited" })
      }
    }

    // Unknown — send a 404 so tests surface missed routes.
    return json(404, { error: "mock: not implemented", method, path })
  }
}

/** Convenience factory used by specs. */
export function installMockLicenseApi(page: Page): MockLicenseApi {
  const api = new MockLicenseApi()
  void api.install(page)
  return api
}
