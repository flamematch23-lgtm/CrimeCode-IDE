# Cloudflare Tunnel Setup for OpenCode

## Prerequisites

- Account Cloudflare (gratuito su dash.cloudflare.com)
- Autorizzazione tramite `cloudflared tunnel login`

## Setup Rapido

### 1. Login a Cloudflare

```bash
cloudflared tunnel login
```

Segui il link nel browser e autorizza.

### 2. Crea il tunnel

```bash
cloudflared tunnel create opencode
```

### 3. Configura il tunnel (entrambe le porte)

Crea file `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: opencode.your-domain.workers.dev
    service: http://localhost:56912
  - hostname: relay.your-domain.workers.dev
    service: tcp://localhost:3747
  - service: http_status:404
```

### 4. Esegui il tunnel

```bash
cloudflared tunnel run opencode
```

## URL Pubblici

Dopo il setup avrai:

- **Server**: `https://opencode.your-domain.workers.dev`
- **Relay**: `wss://relay.your-domain.workers.dev`

## Alternative: Tunnel Temporaneo (No Domain)

Per test senza dominio personalizzato:

```bash
cloudflared tunnel --url http://localhost:56912
```

Questo ti darà un URL temporaneo `.trycloudflare.com`.

## Per Live Share con WebSocket

Cloudflare Tunnel supporta nativamente WebSocket. Il relay sulla porta 3747 funzionerà se configuri correttamente il tunnel.
