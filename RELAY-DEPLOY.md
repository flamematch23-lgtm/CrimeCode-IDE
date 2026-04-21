# OpenCode Relay — WAN Deployment Guide

The relay server lets two OpenCode users on different networks (different houses,
ISPs, countries) live-share a session. Pick **one** of the four options below.

---

## Option 1 — Cloudflare Quick Tunnel (zero-deploy, easiest)

Built into the CLI. No account, no signup, no DNS. Tunnel dies when you Ctrl+C.

```bash
# install cloudflared once: https://github.com/cloudflare/cloudflared/releases
opencode relay tunnel
```

Output:

```
Public relay ready!
URL: https://something-random.trycloudflare.com

Use it with:
  opencode share start --relay wss://something-random.trycloudflare.com
```

Send the share code from `opencode share start` to your friend, who runs:

```bash
opencode share join <CODE> --relay wss://something-random.trycloudflare.com
```

Best for: ad-hoc sessions. Limit: URL changes every restart, ~10min idle limit on free tier.

---

## Option 2 — ngrok (also zero-deploy)

```bash
opencode relay start &
ngrok http 3747
# copy the wss:// URL from ngrok dashboard
opencode share start --relay wss://abc-123.ngrok-free.app
```

---

## Option 3 — Fly.io (free tier, persistent URL)

```bash
# install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth login
fly launch --no-deploy --copy-config --name my-relay
fly deploy
# URL is wss://my-relay.fly.dev
```

Now anyone can use it forever:

```bash
opencode share start --relay wss://my-relay.fly.dev
```

The included `fly.toml` uses a 256MB shared-cpu-1x machine (free).

---

## Option 4 — Railway / Render / any Docker host

```bash
docker build -t opencode-relay .
docker run -p 3747:3747 opencode-relay
```

Or push to Railway with the included `railway.json` — it auto-detects the Dockerfile.

For Render: create a "Web Service", point at this repo, set port `3747`, Docker build.

---

## Self-host on a VPS

```bash
git clone <repo>
cd opencode
bun install
RELAY_PORT=3747 bun run relay-server.ts
# put nginx/caddy in front for TLS
```

Caddy one-liner:

```
relay.example.com {
  reverse_proxy localhost:3747
}
```

---

## Test a relay

```bash
curl https://YOUR_RELAY/health
# {"status":"ok","hosts":0,"clients":0,"invites":0}

opencode relay stats --url https://YOUR_RELAY
```

---

## Security notes

- Anyone with your share **code + token** can join. Always use `--token <secret>` on `share start` for relay mode.
- Codes expire after 30 minutes.
- Host disconnect grace is 30s — clients see `host_paused` then are dropped if you don't return.
- Heartbeat: 20s ping / 45s timeout.
