# CrimeOpus API — Self-hosted OpenAI-compatible gateway

Single-binary Bun + Hono server che espone i tuoi modelli locali Ollama come
un cloud provider OpenAI standard. Lo configuri in OpenCode (e in qualsiasi
altro client OpenAI-compatible) come se fosse un servizio commerciale.

```
┌─ Ollama (locale, mai esposto) ─┐    ┌─ CrimeOpus API ─┐    ┌─ Client (OpenCode, web app, ...) ─┐
│ crimeopus-default               │ ←──│  + auth         │←───│  baseURL: https://api.crime.dev    │
│ crimeopus-coder                 │    │  + rate limit   │    │  apiKey:  sk-xxxx                  │
│ crimeopus-italian               │    │  + usage logs   │    │  → /v1/chat/completions            │
│ ...                             │    │  + catalog      │    │                                    │
└─────────────────────────────────┘    └─────────────────┘    └────────────────────────────────────┘
```

## Cosa fa

- **API OpenAI 1:1** — endpoints `/v1/models`, `/v1/chat/completions` (incl. streaming SSE), `/v1/embeddings`. Funziona out-of-the-box con qualsiasi SDK / IDE / chat client che supporti OpenAI.
- **Auth via API-key** — bearer token validato contro un set di chiavi configurabili (JSON o CSV via env).
- **Rate limit per chiave** — token bucket in-memory (60 req/min default, override per chiave). Niente Redis richiesto.
- **Usage log SQLite** — una riga per richiesta: timestamp, label chiave, IP, modello, token, latenza, status. Serve per fatturazione, debug, audit.
- **Catalog brandable** — il client vede `crimeopus-default` invece di `hf.co/mradermacher/...:IQ4_XS`. Puoi nascondere modelli interni, iniettare system prompt, limitare context.
- **Streaming completo** — il SSE viene piped attraverso byte-by-byte con riscrittura del campo `model` per coerenza.
- **Healthcheck** `/healthz` — controlla anche stato upstream Ollama.
- **Docker / Cloudflare Tunnel / VPS / Fly.io** — distribuibile come immagine Docker o binary `--compile`-d standalone.

## Avvio rapido locale

```bash
# 1. Installa dipendenze
cd packages/crimeopus-api
bun install

# 2. Configura
cp .env.example .env
# edita .env e setta API_KEYS

# 3. Crea il catalog (opzionale ma raccomandato in prod)
cp catalog.example.json catalog.json
# edita catalog.json se vuoi cambiare display name / hide modelli

# 4. Lancia
bun run dev
# → ✓ CrimeOpus API listening on http://0.0.0.0:8787
```

Test:
```bash
# Lista modelli
curl -H "Authorization: Bearer sk-dev-CHANGE-ME" http://localhost:8787/v1/models

# Chat completion
curl -H "Authorization: Bearer sk-dev-CHANGE-ME" \
     -H "Content-Type: application/json" \
     -d '{"model":"crimeopus-default","messages":[{"role":"user","content":"ciao"}]}' \
     http://localhost:8787/v1/chat/completions

# Streaming
curl -N -H "Authorization: Bearer sk-dev-CHANGE-ME" \
     -H "Content-Type: application/json" \
     -d '{"model":"crimeopus-default","stream":true,"messages":[{"role":"user","content":"raccontami una barzelletta"}]}' \
     http://localhost:8787/v1/chat/completions
```

## Deploy production

### Opzione A · Docker Compose (raccomandato per VPS)

```bash
cd packages/crimeopus-api
cp .env.example .env
# edita .env: imposta API_KEYS reali, RATE_LIMIT, CORS_ORIGINS

cp catalog.example.json catalog.json
# personalizza il catalog

docker compose up -d
docker compose exec ollama ollama pull crimeopus-default
docker compose logs -f api
```

Davanti metti un reverse proxy con TLS (Caddy è il più semplice):

```caddy
# /etc/caddy/Caddyfile
api.crimeopus.dev {
    reverse_proxy 127.0.0.1:8787
    encode zstd gzip
}
```

```bash
sudo systemctl reload caddy
# Caddy negozia automaticamente Let's Encrypt
```

### Opzione B · Cloudflare Tunnel (zero VPS / IP pubblico)

Quando il tuo Ollama gira su una macchina dietro NAT o senza IP pubblico:

```bash
# Installa cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

# Crea il tunnel
cloudflared tunnel create crimeopus-api
cloudflared tunnel route dns crimeopus-api api.tuo-dominio.dev

# config.yml
cat > ~/.cloudflared/config.yml <<'YAML'
tunnel: crimeopus-api
credentials-file: ~/.cloudflared/<UUID>.json
ingress:
  - hostname: api.tuo-dominio.dev
    service: http://localhost:8787
  - service: http_status:404
YAML

# Avvia
cloudflared tunnel run crimeopus-api &
bun run packages/crimeopus-api/src/index.ts
```

Risultato: `https://api.tuo-dominio.dev/v1/...` arriva al tuo Ollama locale, con TLS gestito da Cloudflare.

### Opzione C · Single binary su VPS (no Docker)

```bash
# Sulla tua macchina con Bun installato
cd packages/crimeopus-api
bun run compile
# → dist/crimeopus-api  (binario standalone con runtime embedded, ~80 MB)

# Copialo sul VPS
scp dist/crimeopus-api user@vps:/opt/crimeopus/

# systemd unit su VPS
cat > /etc/systemd/system/crimeopus-api.service <<'UNIT'
[Unit]
Description=CrimeOpus API
After=network-online.target ollama.service
Requires=ollama.service

[Service]
ExecStart=/opt/crimeopus/crimeopus-api
Environment=PORT=8787
Environment=BIND=127.0.0.1
Environment=OLLAMA_URL=http://127.0.0.1:11434
Environment=API_KEYS={"sk-prod-XXX":"prod"}
Environment=CATALOG_PATH=/opt/crimeopus/catalog.json
Environment=LOG_DB=/var/lib/crimeopus/usage.db
Restart=on-failure
User=crimeopus

[Install]
WantedBy=multi-user.target
UNIT

systemctl enable --now crimeopus-api
```

## Integrazione in OpenCode

Aggiungi al tuo `.opencode/opencode.jsonc` (o `~/.config/opencode/opencode.jsonc`):

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
      "models": {
        "crimeopus-default": {
          "name": "CrimeOpus 4.7 Code Elite",
          "type": "chat",
          "limit": { "context": 8192, "output": 2048 }
        },
        "crimeopus-coder": {
          "name": "CrimeOpus 4.7 CODER",
          "type": "chat",
          "limit": { "context": 16384, "output": 4096 }
        },
        "crimeopus-italian": {
          "name": "CrimeOpus 4.7 Italiano",
          "type": "chat",
          "limit": { "context": 8192, "output": 2048 }
        }
      }
    }
  }
}
```

L'utente esporta una sola env var:

```bash
export CRIMEOPUS_API_KEY=sk-prod-xxx     # dato dall'admin del server
```

E il model picker di OpenCode mostra **"CrimeOpus Cloud"** con i tuoi modelli — esattamente come per Anthropic / OpenAI.

## Distribuzione modelli ai tuoi utenti

Per condividere il provider con altri utenti / membri team:

1. **Genera una chiave per ciascuno**:
   ```bash
   # genera 32 byte randomici, prefissati per leggibilità
   echo "sk-$(openssl rand -hex 16)"
   # → sk-abc123def456...
   ```
2. **Aggiungila al server** (`API_KEYS` env var) con label parlante (`alice`, `bob`, …) — vedrai chi consuma cosa nei log.
3. **Mandagli un blob JSONC** già pronto (vedi sezione precedente) con il loro `CRIMEOPUS_API_KEY` come segnaposto.
4. **Monitora consumi** con SQL diretto sul `usage.db`:
   ```sql
   SELECT key_label, COUNT(*) AS req, SUM(prompt_tokens+completion_tokens) AS tok
   FROM usage WHERE ts > strftime('%s','now','-1 day')*1000
   GROUP BY key_label ORDER BY tok DESC;
   ```

## Catalog

Il file `catalog.json` controlla cosa il client vede vs cosa l'upstream sa fare:

```jsonc
{
  "crimeopus-default": {
    "upstream": "crimeopus-default:latest",     // tag Ollama reale
    "display": "CrimeOpus 4.7 Code Elite",      // nome mostrato nel picker
    "description": "Flagship multilingue.",
    "maxContext": 8192,
    "systemPrefix": "Sei CrimeOpus..."          // injection automatica system prompt
  },
  "internal-debug": {
    "upstream": "qwen2.5-coder:14b",
    "hidden": true                              // non in /v1/models, ma callable
  }
}
```

## Sicurezza

- ✅ **Auth obbligatoria** — il server rifiuta partenza se `API_KEYS` è vuoto, a meno di `ALLOW_ANON=1` (solo dev).
- ✅ **Bind 127.0.0.1 di default** quando dietro reverse proxy. L'env `BIND=0.0.0.0` è solo per Docker.
- ✅ **Rate limit** evita brute-force / DoS.
- ✅ **CORS configurabile** — `*` per dev, lista esplicita per prod.
- ⚠️ **HTTPS obbligatorio** in pubblico — usa Caddy / Cloudflare / nginx davanti. Le API key viaggiano in chiaro nell'header.
- ⚠️ **Log delle chiavi** — il `usage.db` salva la *label* della chiave, mai la chiave stessa. Le chiavi non vengono mai stampate sui log.

## Estensioni future

- `/v1/audio/transcriptions` (Whisper bridging)
- Multi-tenant via JWT al posto di API key statiche
- Quota mensili per chiave (con reset automatico)
- Dashboard web `/admin` per gestione chiavi + statistiche
- Webhook su superamento quota / errori upstream

## License

MIT — riusa, modifica, ridistribuisci.
