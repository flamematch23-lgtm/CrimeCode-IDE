# CrimeOpus API — Self-hosted OpenAI-compatible gateway

Gateway Bun + Hono che espone i tuoi modelli locali (Ollama / Whisper) come
un cloud provider OpenAI standard. Lo configuri in OpenCode e in qualsiasi
altro client OpenAI-compatible come se fosse un servizio commerciale.

```
┌─ Ollama / Whisper (locale) ─┐    ┌─ CrimeOpus API ─┐    ┌─ Client (OpenCode, web app, …) ─┐
│ crimeopus-default            │ ←──│  + auth         │←───│  baseURL: https://api.crime.dev  │
│ crimeopus-coder              │    │  + quota mensile│    │  apiKey:  sk-xxxx (o JWT)        │
│ whisper-large-v3             │    │  + admin UI     │    │  → /v1/chat/completions          │
│ ...                          │    │  + webhooks     │    │  → /v1/audio/transcriptions      │
└──────────────────────────────┘    └─────────────────┘    └──────────────────────────────────┘
```

## Cosa fa (v0.2.0)

### Endpoints OpenAI 1:1
| Endpoint | Scope | Quota tracked |
|---|---|---|
| `GET /v1/models` | `models:list` | — |
| `POST /v1/chat/completions` (streaming + non) | `chat` | ✅ |
| `POST /v1/embeddings` | `embed` | ✅ |
| `POST /v1/audio/transcriptions` | `audio` | ✅ |
| `POST /v1/audio/translations` | `audio` | ✅ |
| `GET /healthz` | — | — |
| `GET /admin` (web SPA + JSON API) | basic-auth | — |

### Auth
- **Static API keys** (env `API_KEYS` JSON o CSV, oppure DB tramite `/admin`)
- **JWT bearer** (HS256 con `JWT_SECRET` o RS256 con `JWT_PUBLIC_KEY`) — auto-onboard tenant al primo request
- **Scopes per chiave**: `models:list`, `chat`, `embed`, `audio` (parziali OK)

### Quote mensili
- Per ogni chiave: `monthly_token_quota` + `monthly_request_quota` (NULL = illimitato)
- Reset automatico a inizio mese UTC (rollover trasparente)
- Webhook `quota.warning` a 80%, `quota.exceeded` a 100% (blocca ulteriori richieste)
- Storia ultimi 12 periodi visibile dal dashboard

### Rate limit
- Token bucket per chiave (60 rpm / burst 10 default, override per chiave)
- Webhook `ratelimit.exceeded` quando il bucket si svuota

### Webhooks
- Subscribe da `/admin` o via API: `POST /admin/api/webhooks {url, event, secret}`
- Eventi: `quota.warning`, `quota.exceeded`, `upstream.error`, `ratelimit.exceeded`, `audio.error`, `key.created`, `key.disabled`, `*`
- Firma HMAC-SHA256 in header `X-CrimeOpus-Signature` (convenzione GitHub)
- Retry esponenziale 3 tentativi (1s/3s/10s)
- Audit trail in `webhook_deliveries`

### Admin web UI
- `GET /admin` (auth: basic, password = `ADMIN_PASSWORD`)
- 4 tab:
  - **Overview**: cards live (last 24h, 7d, errors, tokens), grafico bar 24×1h, top models, top keys
  - **Keys & Quota**: lista con barre uso/quota, generate, edit, disable, reset quota
  - **Webhooks**: subscribe, toggle, delete
  - **Deliveries**: 100 ultimi tentativi con status code + error excerpt
- Auto-refresh 10s

### Whisper bridging
- Forward trasparente di multipart `file/model/response_format/...` a un upstream OpenAI-compatible
- Compatibile con `faster-whisper-server`, `whisper.cpp server`, `localai`
- Configurazione: `WHISPER_URL` + `WHISPER_API_KEY` (opzionale) + `WHISPER_MODEL_DEFAULT`
- Webhook `audio.error` su upstream failure

### Catalog brandable
File `catalog.json` opzionale: `public_id → { upstream, display, description, hidden, maxContext, systemPrefix }`. Il client vede solo i nomi pubblici, l'upstream resta nascosto.

### HuggingFace → Ollama installer
`bun run install-models` legge `models.config.json`, scarica i GGUF (anche da repo privati con `HF_TOKEN`), genera Modelfile, lancia `ollama create`. Idempotente.

## Quickstart locale

```bash
cd packages/crimeopus-api
bun install
cp .env.example .env
# edita .env: imposta API_KEYS, opzionalmente ADMIN_PASSWORD + JWT_SECRET

cp catalog.example.json catalog.json
# personalizza i display name dei modelli

bun run dev
# → ✓ CrimeOpus API listening on http://0.0.0.0:8787
#   admin dashboard: enabled at /admin
#   jwt: HS256
```

Test:
```bash
# Lista modelli
curl -H "Authorization: Bearer sk-prod-CHANGE-ME" http://localhost:8787/v1/models

# Chat
curl -H "Authorization: Bearer sk-prod-CHANGE-ME" \
     -H "Content-Type: application/json" \
     -d '{"model":"crimeopus-default","messages":[{"role":"user","content":"ciao"}]}' \
     http://localhost:8787/v1/chat/completions

# Whisper transcription (richiede WHISPER_URL configurato)
curl -H "Authorization: Bearer sk-prod-CHANGE-ME" \
     -F file=@audio.mp3 \
     -F model=whisper-1 \
     http://localhost:8787/v1/audio/transcriptions

# Admin dashboard
open http://localhost:8787/admin
# → Basic auth: admin / <ADMIN_PASSWORD>
```

## Multi-tenant via JWT

Genera un JWT per un tenant:
```bash
JWT_SECRET=$(openssl rand -hex 32) \
  bun run issue-jwt -- \
    --sub tenant-acme \
    --label "Acme Corp" \
    --rpm 120 \
    --token-quota 5000000 \
    --request-quota 50000 \
    --scopes chat,embed \
    --expires-in 30d

# → eyJhbGc...
```

Manda il JWT al cliente. Al primo request crea automaticamente una riga in `keys (kind='jwt', tenant_id='tenant-acme')` con quote/scopes/rpm dal JWT, visibile nel dashboard come una qualsiasi static key.

In OpenCode:
```bash
export CRIMEOPUS_API_KEY=eyJhbGc...
```

## Distribuzione modelli

`models.config.json` (vedi `models.config.example.json`):

```json
{
  "ollama_url": "http://127.0.0.1:11434",
  "models_dir": "./models-cache",
  "models": [
    {
      "name": "crimeopus-default",
      "hf_repo": "yourorg/CrimeOpus-4.7-Opus-GGUF",
      "hf_file": "CrimeOpus4.7-Opus.IQ4_XS.gguf",
      "private": true,
      "modelfile": {
        "system": "Sei CrimeOpus...",
        "parameters": { "num_ctx": 8192, "temperature": 0.6 }
      }
    }
  ]
}
```

```bash
HF_TOKEN=hf_xxx bun run install-models
# Scarica → genera Modelfile → ollama create. Idempotente.
```

## Webhook signature verification (esempio Node receiver)

```js
import { createHmac, timingSafeEqual } from "node:crypto"

function verifyCrimeopusSignature(rawBody, header, secret) {
  if (!header?.startsWith("sha256=")) return false
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const got = header.slice(7)
  return got.length === expected.length &&
    timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"))
}
```

## Deploy production

### A · Docker Compose (raccomandato)
```bash
cp .env.example .env
cp catalog.example.json catalog.json
docker compose up -d
docker compose exec ollama ollama pull crimeopus-default
```

Caddy davanti per TLS:
```caddy
api.crimeopus.dev {
  reverse_proxy 127.0.0.1:8787
  encode zstd gzip
}
```

### B · Cloudflare Tunnel (zero VPS)
```bash
cloudflared tunnel create crimeopus-api
cloudflared tunnel route dns crimeopus-api api.tuo-dominio.dev
cloudflared tunnel run crimeopus-api &
bun run packages/crimeopus-api/src/index.ts
```

### C · Single-binary VPS
```bash
bun run compile
# → dist/crimeopus-api  (binary self-contained ~80 MB)
scp dist/crimeopus-api vps:/opt/crimeopus/
# + systemd unit (esempio in vecchio README v0.1)
```

## Configurazione completa env

Vedi `.env.example` per la lista completa. Variabili principali:

| Var | Default | Cosa fa |
|---|---|---|
| `PORT` / `BIND` | 8787 / 0.0.0.0 | Listener |
| `OLLAMA_URL` | http://127.0.0.1:11434 | Upstream chat / embed |
| `WHISPER_URL` | http://127.0.0.1:9000 | Upstream STT |
| `API_KEYS` | (none) | JSON o CSV — sync nel DB al boot |
| `JWT_SECRET` | (none) | HS256 secret per JWT multi-tenant |
| `JWT_PUBLIC_KEY` | (none) | RS256 PEM (alternativa) |
| `ADMIN_PASSWORD` | (none) | Abilita /admin |
| `RATE_LIMIT_RPM` / `RATE_LIMIT_BURST` | 60 / 10 | Token bucket default |
| `CORS_ORIGINS` | * | Lista CSV per prod |
| `LOG_DB` / `CATALOG_PATH` | ./usage.db / ./catalog.json | Storage |
| `ALLOW_ANON` | (none) | DEV only — disabilita auth |

## Sicurezza checklist prod

- ✅ Set `API_KEYS` (mai con `ALLOW_ANON=1` in prod)
- ✅ Set `ADMIN_PASSWORD` con password forte (≥20 char) o disabilita `/admin`
- ✅ HTTPS davanti (Caddy / Cloudflare / nginx)
- ✅ `CORS_ORIGINS` lista esplicita per prod
- ✅ Bind 127.0.0.1 quando dietro reverse proxy
- ✅ Webhook secrets impostati per ogni subscriber
- ✅ Backup periodico `usage.db` (contiene chiavi! — almeno encrypted at rest)
- ⚠️ Le static keys non sono cifrate at-rest in SQLite — usa filesystem cifrato o solo JWT + key rotation

## Integrazione OpenCode (utenti finali)

Distribuisci `opencode.cloud.example.jsonc` (rinominato in `.opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "crimeopus/crimeopus-default",
  "provider": {
    "crimeopus": {
      "name": "CrimeOpus Cloud",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.tuo-dominio.dev/v1",
        "apiKey": "{env:CRIMEOPUS_API_KEY}"
      },
      "models": { "crimeopus-default": ..., ... }
    }
  }
}
```

L'utente esporta `CRIMEOPUS_API_KEY=sk-xxx` (o un JWT) e nel model picker di OpenCode appare **CrimeOpus Cloud**.

## License

MIT
