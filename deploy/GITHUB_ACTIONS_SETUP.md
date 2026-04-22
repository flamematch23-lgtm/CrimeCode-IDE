# GitHub Actions Deploy — One-Time Setup

The `.github/workflows/deploy.yml` workflow auto-deploys both the API (Fly.io)
and the Web app (Cloudflare Pages) on every push to `master`. Before the first
run, configure the three required repository secrets.

## Required secrets

Go to **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**
and add these three:

| Name | Value | How to obtain |
|------|-------|---------------|
| `FLY_API_TOKEN` | `FlyV1 fm2_…` | `fly tokens create deploy --app crimecode-api --expiry 8760h` |
| `CLOUDFLARE_API_TOKEN` | `cfut_…` or `cf-…` | https://dash.cloudflare.com/profile/api-tokens → Create → "Cloudflare Pages: Edit" |
| `CLOUDFLARE_ACCOUNT_ID` | 32-char hex | https://dash.cloudflare.com → sidebar bottom-right → Account ID |

## Setting them via `gh` CLI

If you have the GitHub CLI authenticated:

```bash
gh secret set FLY_API_TOKEN          --body "<token>" --repo flamematch23-lgtm/CrimeCode-IDE
gh secret set CLOUDFLARE_API_TOKEN   --body "<token>" --repo flamematch23-lgtm/CrimeCode-IDE
gh secret set CLOUDFLARE_ACCOUNT_ID  --body "<id>"    --repo flamematch23-lgtm/CrimeCode-IDE
```

## What the workflow does

On every push to `master` that touches relevant paths:

1. **`deploy-api`** job (parallel)
   - Checkout
   - Install `flyctl`
   - `fly deploy --config deploy/api/fly.toml --app crimecode-api --remote-only`
     (uses Fly's remote builder — no local Docker context upload!)
   - Health check `https://crimecode-api.fly.dev/` (5 retries × 10s)

2. **`deploy-web`** job (parallel)
   - Checkout
   - Install Bun
   - `bun install`
   - `VITE_API_URL=https://crimecode-api.fly.dev bun run --cwd packages/app build`
   - `wrangler pages deploy packages/app/dist --project-name=crimecode-web --branch=main`

Both jobs run **in parallel** for ~3-5 minutes total.

## Manual trigger

You can also trigger the workflow without a push:
- GitHub repo → Actions tab → "Deploy (API + Web)" → Run workflow

## Path filters

The workflow only runs when relevant files change. Editing `README.md` or
`packages/desktop-electron/**` won't trigger a redeploy. See the `paths:`
list in `deploy.yml` to adjust.

## Why CI is faster than local

The Fly remote-only build runs on Fly's beefy build machines (gigabit network +
fast CPUs) — your local upload via residential broadband is the bottleneck for
the first 100MB+ Docker context. CI sees the repo via fast GitHub→Fly link.

Typical times:
- Local deploy from home connection: 10–20 min (upload-bound)
- GitHub Actions deploy: 2–5 min total (parallel jobs, fast network)

## Rollback

To rollback the API:
```bash
fly releases --app crimecode-api          # list releases
fly releases rollback <version> --app crimecode-api
```

To rollback the web app:
- Cloudflare Pages dashboard → crimecode-web → Deployments → click "Restore"
  on a previous deployment.
