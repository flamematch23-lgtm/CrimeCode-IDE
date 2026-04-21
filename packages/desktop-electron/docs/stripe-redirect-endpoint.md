# Stripe Checkout Redirect Endpoint — Design & Reference

The desktop app's `license-open-checkout` IPC handler (`packages/desktop-electron/src/main/ipc.ts`) opens:

```
https://opencode.ai/billing/pro?interval=<monthly|annual|lifetime>&returnTo=opencode%3A%2F%2Factivate
```

Your backend must:
1. Accept `?interval=…&returnTo=…`
2. Create a Stripe Checkout Session for the right price ID
3. After successful payment, redirect to `returnTo` with `?interval=…&token=<license_token>` appended

The app's main process deep-link handler (`src/main/index.ts::handleActivateDeepLink`) then activates the license locally.

## Reference price IDs

Replace with your real Stripe dashboard IDs:

| interval | Stripe price ID | Example |
|----------|----------------|---------|
| `monthly` | `price_monthly_xxx` | $20/month |
| `annual` | `price_annual_xxx` | $200/year |
| `lifetime` | `price_lifetime_xxx` | $500 one-time |

## Option A — Cloudflare Worker (recommended)

```ts
// wrangler.toml
// compat_date = "2025-01-01"
// [vars]
// STRIPE_SECRET_KEY = ...  (use wrangler secret)

import Stripe from "stripe"

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const interval = url.searchParams.get("interval")
    const returnTo = url.searchParams.get("returnTo") ?? "opencode://activate"

    const priceMap: Record<string, string> = {
      monthly: env.STRIPE_PRICE_MONTHLY,
      annual: env.STRIPE_PRICE_ANNUAL,
      lifetime: env.STRIPE_PRICE_LIFETIME,
    }
    const price = interval ? priceMap[interval] : undefined
    if (!price) return new Response("Invalid interval", { status: 400 })

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" })
    const session = await stripe.checkout.sessions.create({
      mode: interval === "lifetime" ? "payment" : "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: `${new URL(req.url).origin}/billing/complete?session_id={CHECKOUT_SESSION_ID}&interval=${interval}&returnTo=${encodeURIComponent(returnTo)}`,
      cancel_url: `${new URL(req.url).origin}/billing/cancel`,
    })

    return Response.redirect(session.url!, 303)
  },
}
```

Then the `/billing/complete` handler:

```ts
// fetch session, generate license token (e.g. signed JWT with your secret),
// then 302 to:
//   `${returnTo}?interval=${interval}&token=${licenseToken}`
```

## Option B — Hono / Node / Next.js API route

Same shape; the essential steps:
1. Validate `interval`
2. Create Checkout Session with `success_url` pointing at your callback
3. Callback handler verifies session → signs a license token → redirects to `returnTo`

## License token format

The app currently treats the token as an opaque string stored in
`licenseService.activateFromToken({ interval, token })`. Recommended format:
a short-lived JWT signed with a server-side secret, containing:

```json
{
  "sub": "<stripe_customer_id>",
  "interval": "monthly|annual|lifetime",
  "iat": 1729634400,
  "exp": 1761170400
}
```

The desktop app does NOT currently verify the JWT (no signing key in the
client). Token verification happens server-side on every subsequent license
check. For a v1 shipping today without server-side verification you can use
any opaque random string; tighten later.

## Testing locally

Use `ngrok` to expose a local dev server on HTTPS, then set:

```bash
export OPENCODE_CHECKOUT_BASE_URL="https://<your-ngrok>.ngrok-free.app/billing/pro"
```

…and re-build the desktop app. The `license-open-checkout` IPC will now hit your local worker/server.

## Deep-link activation flow summary

```
User clicks "Subscribe Monthly" in SubscriptionModal
  └─> window.api.license.openCheckout("monthly")
  └─> main: shell.openExternal("https://opencode.ai/billing/pro?interval=monthly&returnTo=opencode://activate")
  └─> Browser opens → Stripe Checkout → user pays
  └─> 302 → opencode://activate?interval=monthly&token=<jwt>
  └─> OS dispatches to opencode desktop app via "opencode://" protocol registration
  └─> main: handleActivateDeepLink parses → licenseService.activateFromToken(...)
  └─> License persisted to electron-store; renderer refetches → Pro active
```
