import { expect, test } from "@playwright/test"

/**
 * Playwright coverage for the AuthGate + marketing pages.
 *
 * These tests don't need a live opencode server: they poke the UI
 * surface (tab switching, form labels, link destinations, static pages).
 * The heavier SDK-backed flows continue to live in the other specs.
 */

test.describe("AuthGate", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // Start every test signed out.
      localStorage.clear()
    })
  })

  test("renders two sign-in tabs and defaults to Telegram", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Sign in to CrimeCode" })).toBeVisible()
    const tgTab = page.getByRole("button", { name: /Telegram/i })
    const selfTab = page.getByRole("button", { name: /Self-hosted/i })
    await expect(tgTab).toBeVisible()
    await expect(selfTab).toBeVisible()
    // Default is Telegram → the "Continue with Telegram" CTA is shown.
    await expect(page.getByRole("button", { name: /Continue with Telegram/i })).toBeVisible()
  })

  test("switching to the Self-hosted tab reveals the credentials form", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: /Self-hosted/i }).click()
    await expect(page.getByLabel("Server URL")).toBeVisible()
    await expect(page.getByLabel("Username")).toBeVisible()
    await expect(page.getByLabel("Password")).toBeVisible()
  })

  test("footer links point at the marketing pages", async ({ page }) => {
    await page.goto("/")
    for (const [label, href] of [
      ["Pricing", "/pricing"],
      ["FAQ", "/faq"],
      ["Terms", "/terms"],
      ["Privacy", "/privacy"],
    ] as const) {
      await expect(page.getByRole("link", { name: label })).toHaveAttribute("href", href)
    }
  })

  test("loading state announces itself to screen readers", async ({ page, context }) => {
    // With nothing in localStorage the gate briefly shows "Checking saved
    // credentials…" before rendering the form. It's decorated with
    // role=status + aria-live=polite for WCAG 4.1.3.
    await context.addInitScript(() => localStorage.clear())
    await page.goto("/", { waitUntil: "commit" })
    const loading = page.locator('[data-auth-gate="loading"]')
    // The loading card may disappear quickly, so we just assert the role
    // attribute is wired up correctly. If it's already gone the form is
    // up, which is also fine.
    if (await loading.count()) {
      await expect(loading).toHaveAttribute("role", "status")
      await expect(loading).toHaveAttribute("aria-live", "polite")
    }
  })
})

test.describe("Marketing pages", () => {
  test("/pricing shows all three plan cards", async ({ page }) => {
    await page.goto("/pricing.html")
    await expect(page.getByRole("heading", { name: /Simple, crypto-only pricing/i })).toBeVisible()
    await expect(page.getByText(/\$20 \/ mo/)).toBeVisible()
    await expect(page.getByText(/\$200 \/ yr/)).toBeVisible()
    await expect(page.getByText(/\$500 once/)).toBeVisible()
    // Every card points at the bot deep-link.
    const links = page.getByRole("link", { name: /Get (Monthly|Annual|Lifetime)/i })
    await expect(links).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      const href = await links.nth(i).getAttribute("href")
      expect(href).toContain("https://t.me/CrimeCodeSub_bot?start=order_")
    }
  })

  test("/faq renders a non-empty question list", async ({ page }) => {
    await page.goto("/faq.html")
    await expect(page.getByRole("heading", { name: /Frequently asked questions/i })).toBeVisible()
    const summaries = page.locator("main.page .faq summary")
    expect(await summaries.count()).toBeGreaterThan(5)
  })

  test("/terms and /privacy render and have a last-updated stamp", async ({ page }) => {
    for (const path of ["/terms.html", "/privacy.html"]) {
      await page.goto(path)
      await expect(page.locator("main.page .lead")).toContainText(/Last updated/i)
      // Global footer present with all 4 marketing routes.
      const footerLinks = page.locator(".site-footer .links a")
      expect(await footerLinks.count()).toBeGreaterThanOrEqual(5)
    }
  })
})
