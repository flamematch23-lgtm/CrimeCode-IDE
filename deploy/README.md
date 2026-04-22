# Deploy — OpenCode Web Stack

This folder contains the deploy configs for hosting the web app + API server.

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────┐
│  Cloudflare Pages          │  HTTPS  │  Fly.io (Frankfurt)      │
│  crimecode-web.pages.dev   │ ───────►│  crimecode-api.fly.dev   │
│  (SolidJS SPA, static)     │         │  (Bun headless server)   │
│  Build: packages/app/dist  │         │  Password-protected      │
└────────────────────────────┘         └──────────────────────────┘
```

Both are free-tier / pay-per-use:
- Cloudflare Pages: unlimited bandwidth on free tier
- Fly.io: 1 `shared-cpu-1x` @ 512 MB always-on fits in the free allowance

## First-time setup

### Backend (Fly.io)

```bash
# from repo root
fly auth login                                       # one-time, opens browser
fly apps create crimecode-api                        # one-time
fly secrets set \
  OPENCODE_SERVER_PASSWORD="<32-char-random>" \
  --app crimecode-api
fly deploy --config deploy/api/fly.toml --app crimecode-api
```

Public URL: `https://crimecode-api.fly.dev`

### Frontend (Cloudflare Pages)

1. Get a Cloudflare API Token:
   - Go to https://dash.cloudflare.com/profile/api-tokens
   - Click **Create Token** → pick the **Edit Cloudflare Workers** template
   - The token needs "Account: Cloudflare Pages: Edit" permission
2. Get your account ID from the Cloudflare dashboard sidebar.
3. Set env vars:
   ```bash
   export CLOUDFLARE_API_TOKEN=<token>
   export CLOUDFLARE_ACCOUNT_ID=<account_id>
   ```
4. Build + deploy:
   ```bash
   # from repo root
   VITE_API_URL=https://crimecode-api.fly.dev \
     bun run --cwd packages/app build
   bunx wrangler pages deploy packages/app/dist \
     --project-name=crimecode-web \
     --branch=main
   ```

Public URL: `https://crimecode-web.pages.dev`

## Subsequent deploys

### Backend
```bash
fly deploy --config deploy/api/fly.toml --app crimecode-api
```

### Frontend
```bash
VITE_API_URL=https://crimecode-api.fly.dev \
  bun run --cwd packages/app build
bunx wrangler pages deploy packages/app/dist \
  --project-name=crimecode-web \
  --branch=main
```

Or hook the repo to auto-deploy on `git push` — enable the GitHub integration
in the Cloudflare Pages dashboard, and configure Fly.io deploys via GitHub
Actions (`fly deploy --app crimecode-api` in the workflow).

## Secrets management

- `OPENCODE_SERVER_PASSWORD` — never committed. Stored in `fly secrets`.
  Client-side, users enter this at first login to the web app.
- `CLOUDFLARE_API_TOKEN` — developer-machine env var or CI secret, never committed.
- `OPENCODE_ADMIN_PASSPHRASE_SHA256` — only needed for desktop-electron beta/prod
  builds, not the web stack. See `packages/desktop-electron/docs/admin-panel-setup.md`.

## Troubleshooting

- **502 from Fly.io right after deploy:** machine is still booting (20–60s). Check
  `fly logs --app crimecode-api`.
- **Frontend shows "Connection Error":** `VITE_API_URL` wasn't set at build time,
  so the web app tries `location.origin` which won't resolve to the API.
  Rebuild with the env var and redeploy.
- **`OPENCODE_SERVER_PASSWORD is not set; server is unsecured`:** secret wasn't
  applied to the running machine. Run `fly secrets list --app crimecode-api`,
  verify it's there, then `fly deploy` (secrets are applied on deploy).
