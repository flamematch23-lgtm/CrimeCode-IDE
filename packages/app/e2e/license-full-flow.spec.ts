import { expect, test } from "@playwright/test"
import { MockLicenseApi } from "./helpers/mock-license-api"

/**
 * End-to-end simulation of the licensing flow, using Playwright route
 * interception instead of a real backend. The MockLicenseApi keeps
 * state in memory and reacts to requests the same way api.crimecode.cc
 * would. Each scenario drives the mock by calling methods on the api
 * object (e.g. simulateBotClaimsPin) at the right moment.
 */

test.describe("License — full flow", () => {
  let api: MockLicenseApi

  test.beforeEach(async ({ page }) => {
    api = new MockLicenseApi()
    await api.install(page)
    await page.addInitScript(() => localStorage.clear())
  })

  test("Telegram sign-in: PIN → bot claim → session persisted", async ({ page }) => {
    const alice = api.seedCustomer("cus_alice", "@alice", 111)

    await page.goto("/")

    // Override window.open so clicking the bot deep-link doesn't try to
    // navigate away during the test.
    await page.evaluate(() => {
      ;(window as unknown as { open: typeof window.open }).open = () => null
    })

    await page.getByRole("button", { name: /Continue with Telegram/i }).click()

    // The PIN should be visible once /auth/start resolves.
    const pinLocator = page.locator("text=/^[A-Z0-9]{4,20}$/").first()
    await expect(pinLocator).toBeVisible({ timeout: 5_000 })

    // Simulate the bot claiming the PIN on the user's behalf.
    const recordedPin = api.recorded
      .filter((r) => r.method === "POST" && r.url.endsWith("/license/auth/start"))
      .length
    expect(recordedPin).toBe(1)
    // The mock wrote the PIN into its own state — find it.
    const pin = await pinLocator.textContent()
    expect(pin).toBeTruthy()
    api.simulateBotClaimsPin(pin!, alice)

    // The AuthGate polls every ~2 s, so the landing should happen within
    // a few seconds.
    await expect(page.getByRole("heading", { name: "Sign in to CrimeCode" })).toBeHidden({
      timeout: 10_000,
    })

    // localStorage now carries a Bearer session keyed by "crimecode.session".
    const session = await page.evaluate(() => localStorage.getItem("crimecode.session"))
    expect(session).toBeTruthy()
    const parsed = session ? JSON.parse(session) : null
    expect(parsed?.customer_id).toBe("cus_alice")
    expect(parsed?.token?.startsWith("S1.")).toBe(true)
  })

  test("expired PIN surfaces a friendly error", async ({ page }) => {
    api.seedCustomer()
    await page.goto("/")
    await page.evaluate(() => {
      ;(window as unknown as { open: typeof window.open }).open = () => null
    })
    await page.getByRole("button", { name: /Continue with Telegram/i }).click()
    const pinLocator = page.locator("text=/^[A-Z0-9]{4,20}$/").first()
    const pin = await pinLocator.textContent()
    expect(pin).toBeTruthy()
    // Force-expire the PIN without ever claiming it.
    await page.evaluate(() => {
      // Fast-forward the mock's expiry: we don't have a public hook, so
      // override the mock's pin row through a debug global.
    })
    // Simplest: override the mock's map directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(api as unknown as { pins: Map<string, { expires_at: number; claimed_by: null | unknown }> }).pins
      .get(pin!)!.expires_at = Math.floor(Date.now() / 1000) - 10

    // The poll loop runs every 2 s — wait for the error banner.
    await expect(page.getByText(/PIN expired/i)).toBeVisible({ timeout: 10_000 })
  })

  test("authenticated /license/validate round-trip", async ({ page }) => {
    const alice = api.seedCustomer()
    const lic = api.grantLicense(alice, "annual")

    // Drop a fresh session directly into localStorage so we skip the PIN
    // dance — that branch is already covered by the first spec.
    const token = "S1.mock." + alice.id
    ;(api as unknown as { sessions: Map<string, unknown> }).sessions.set(token, {
      token,
      customer_id: alice.id,
      telegram_user_id: alice.telegram_user_id,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86400,
    })

    await page.addInitScript(
      ({ token, customer_id, expires_at }) => {
        localStorage.setItem(
          "crimecode.session",
          JSON.stringify({ token, customer_id, telegram_user_id: null, expires_at }),
        )
      },
      { token, customer_id: alice.id, expires_at: Math.floor(Date.now() / 1000) + 30 * 86400 },
    )

    // Hit the validate endpoint from inside the page so we go through
    // the same route handler our desktop + web clients use.
    const validate = await page.evaluate(async (licToken) => {
      const res = await fetch("https://api.crimecode.cc/license/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: licToken }),
      })
      return res.json()
    }, lic.token)
    expect(validate.status).toBe("valid")
    expect(validate.interval).toBe("annual")

    // A bogus token is rejected with status "unknown".
    const bogus = await page.evaluate(async () => {
      const res = await fetch("https://api.crimecode.cc/license/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "CC2-not-a-real-token" }),
      })
      return res.json()
    })
    expect(bogus.status).toBe("unknown")
  })

  test("authenticated team create + add-member flow", async ({ page }) => {
    const alice = api.seedCustomer()
    const token = "S1.mock." + alice.id
    ;(api as unknown as { sessions: Map<string, unknown> }).sessions.set(token, {
      token,
      customer_id: alice.id,
      telegram_user_id: alice.telegram_user_id,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86400,
    })
    api.seedCustomer("cus_bob", "@bob", 222)

    await page.addInitScript(
      ({ token, customer_id, expires_at }) => {
        localStorage.setItem(
          "crimecode.session",
          JSON.stringify({ token, customer_id, telegram_user_id: null, expires_at }),
        )
      },
      { token, customer_id: alice.id, expires_at: Math.floor(Date.now() / 1000) + 30 * 86400 },
    )

    // Hit /license/teams directly to verify the shared teams-client
    // works end-to-end through the mock.
    const created = await page.evaluate(async () => {
      const res = await fetch("https://api.crimecode.cc/license/teams", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + JSON.parse(localStorage.getItem("crimecode.session")!).token,
        },
        body: JSON.stringify({ name: "Nightshift" }),
      })
      return res.json()
    })
    expect(created.team?.name).toBe("Nightshift")

    const teamId = created.team.id
    const addRes = await page.evaluate(async (id) => {
      const res = await fetch(`https://api.crimecode.cc/license/teams/${id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + JSON.parse(localStorage.getItem("crimecode.session")!).token,
        },
        body: JSON.stringify({ identifier: "@bob" }),
      })
      return res.json()
    }, teamId)
    expect(addRes.mode).toBe("added")

    // The detail endpoint should now list two members with correct roles.
    const detail = await page.evaluate(async (id) => {
      const res = await fetch(`https://api.crimecode.cc/license/teams/${id}`, {
        headers: {
          Authorization: "Bearer " + JSON.parse(localStorage.getItem("crimecode.session")!).token,
        },
      })
      return res.json()
    }, teamId)
    expect(detail.members).toHaveLength(2)
    expect(detail.self_role).toBe("owner")
    const bob = detail.members.find((m: { telegram: string | null }) => m.telegram === "@bob")
    expect(bob?.role).toBe("member")

    // Pending invite path: adding a handle we haven't seeded as a customer.
    const invited = await page.evaluate(async (id) => {
      const res = await fetch(`https://api.crimecode.cc/license/teams/${id}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + JSON.parse(localStorage.getItem("crimecode.session")!).token,
        },
        body: JSON.stringify({ identifier: "@ghost" }),
      })
      return res.json()
    }, teamId)
    expect(invited.mode).toBe("invited")
  })

  test("recorded requests expose the happy-path URL surface", async ({ page }) => {
    const alice = api.seedCustomer()
    await page.goto("/")
    await page.evaluate(() => {
      ;(window as unknown as { open: typeof window.open }).open = () => null
    })
    await page.getByRole("button", { name: /Continue with Telegram/i }).click()
    const pinLocator = page.locator("text=/^[A-Z0-9]{4,20}$/").first()
    const pin = await pinLocator.textContent()
    api.simulateBotClaimsPin(pin!, alice)
    await expect(page.getByRole("heading", { name: "Sign in to CrimeCode" })).toBeHidden({
      timeout: 10_000,
    })

    const urls = api.recorded.map((r) => `${r.method} ${r.url}`)
    expect(urls).toEqual(
      expect.arrayContaining([
        "POST /license/auth/start",
        expect.stringMatching(/^GET \/license\/auth\/poll\//),
      ]),
    )
  })
})
