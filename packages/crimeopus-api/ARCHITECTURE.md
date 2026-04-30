# Architettura production-ready (cloud-first)

```
                    ┌────────────────────────────────────────┐
                    │  CrimeOpus API Gateway (TUO server)    │
                    │  ─────────────────────────────         │
                    │  • Bun + Hono (~1700 linee)            │
                    │  • Auth API key + JWT multi-tenant     │
                    │  • Quote mensili + reset auto          │
                    │  • Rate limit + concurrency cap        │
                    │  • Webhook + dashboard /admin          │
                    │  • SQLite usage log                    │
                    │  • COSTO: ~$5/mese (VPS minimo)        │
                    └────────────────────┬───────────────────┘
                                         │
              ┌──────────────────────────┴──────────────────────────────┐
              │  Upstream pool — il GATEWAY sceglie il primo healthy   │
              │  in failover. PRIORITÀ: cloud (margine), poi fallback. │
              └─┬───────┬───────┬───────┬─────────────┬─────────────┬──┘
                │       │       │       │             │             │
                ▼       ▼       ▼       ▼             ▼             ▼
            Together  Fireworks  Groq  OpenRouter  RunPod      [TUO PC]
            ($0.60/M)  ($0.20/M) ($0.59) (variable) Serverless  (solo dev)
                                                    ($0.50/h
                                                     scale-to-0)
```

## Modelli di costo

### Esempio: 100 utenti × 1M token/mese

**Provider cloud (Together)**
- Costo: 100M token × $0.60/M = **$60/mese di compute**
- Tu vendi: 100 chiavi × $1.50/mese = **$150/mese ricavi**
- Profitto: **$90/mese** (margine 60%)

**RunPod Serverless con tuo modello custom**
- Tempo medio attivo: ~200h/mese (scale-to-zero)
- Costo: 200h × $0.50/h = **$100/mese**
- Modello custom CrimeOpus servito su A100
- Cold start ~20s primo request, ~50ms successivi

**Tuo PC come backend**
- Costo elettricità: ~$30/mese (GPU 24/7)
- Limite throughput: 1-2 user simultaneamente
- Affidabilità: dipende dal tuo uptime
- ⚠️ **Non scala** oltre il primo handful di utenti

## Cosa scegliere

| Situazione | Consiglio |
|---|---|
| **Modelli open già hostati** (Llama, Qwen, DeepSeek, Mistral) | **Together AI** o **OpenRouter** — zero setup |
| **Velocità top + modelli open** | **Groq** (LPU, 500+ tok/s) o **Fireworks** |
| **Modello CrimeOpus CUSTOM tuo** | **Together AI** (custom upload, paghi per token) o **RunPod Serverless** (paghi per tempo, scale-to-zero) |
| **Privacy / dati sensibili / on-prem** | **RunPod / Modal / Lambda Labs** GPU dedicate |
| **Mix economia + reliability** | Pool: Together (3x weight) + OpenRouter (1x weight) come failover |

## Setup raccomandato

### 1. Account cloud (free tier o credito iniziale)

| Provider | Free tier | Setup |
|---|---|---|
| Together AI | $5 credito | https://api.together.xyz/settings/api-keys |
| OpenRouter | $1 credito + free models | https://openrouter.ai/keys |
| Groq | Free tier generoso (~30 req/min) | https://console.groq.com/keys |
| Fireworks | $1 credito | https://fireworks.ai/account/api-keys |

Mettine 2-3 in pool per failover.

### 2. Configura `UPSTREAM_PROVIDERS`

```bash
export UPSTREAM_PROVIDERS='[
  {"id":"together","kind":"openai","url":"https://api.together.xyz/v1","apiKey":"tgs-xxx","weight":3,"maxInflight":10},
  {"id":"groq","kind":"openai","url":"https://api.groq.com/openai/v1","apiKey":"gsk-xxx","weight":2,"maxInflight":5},
  {"id":"openrouter","kind":"openai","url":"https://openrouter.ai/api/v1","apiKey":"sk-or-xxx","weight":1,"maxInflight":5}
]'
```

### 3. Mappa il catalog

`catalog.json`:
```json
{
  "crimeopus-default": {
    "display": "CrimeOpus 4.7",
    "providers": [
      {"provider":"together","model":"Qwen/Qwen2.5-72B-Instruct-Turbo"},
      {"provider":"groq","model":"llama-3.3-70b-versatile"},
      {"provider":"openrouter","model":"qwen/qwen-2.5-72b-instruct"}
    ]
  }
}
```

Il gateway prova nell'ordine: se Together è giù o saturo → Groq → OpenRouter. Trasparente al cliente.

### 4. VPS minimo per il gateway

- **DigitalOcean / Hetzner / Vultr**: $4-6/mese basta (1 CPU, 1 GB RAM)
- Caddy / Cloudflare Tunnel davanti per HTTPS
- Il gateway non fa inferenza, solo routing — niente GPU, niente RAM significativa

### 5. Oppure: zero VPS con Cloudflare Workers

Il gateway si può portare su Workers con qualche modifica (rimuovi SQLite → D1). Costo ~$0 fino a 100k req/mese.

## Cosa hai guadagnato vs versione iniziale

| Feature | v0.2 (Ollama-only) | v0.3 (cloud-first) |
|---|---|---|
| Backend | Tuo PC | Pool cloud (3-5 provider) |
| Scalabilità | 1-2 user | Centinaia/migliaia |
| Affidabilità | Dipende da te | 99.9%+ aggregato |
| Costo fisso | Elettricità + PC | $5/mese VPS gateway |
| Costo variabile | $0 | Per token consumati |
| Modello custom | Sì (locale) | Sì (Together upload o RunPod) |
| Latenza | 500ms-3s (PC debole) | 50-300ms (cloud) |
| Tempo setup | 5 minuti | 30 minuti (creare account) |

## Migration path

Se hai già la versione 0.2 con `OLLAMA_URL`:

1. **Test locale prima**: lascia `OLLAMA_URL` vivo, aggiungi `UPSTREAM_PROVIDERS` con un singolo provider cloud, prova un endpoint
2. **Aggiungi al catalog**: per ogni `crimeopus-*` aggiungi una `providers: [...]` array
3. **Cutover**: rimuovi `OLLAMA_URL`, lascia solo `UPSTREAM_PROVIDERS`
4. **Spegni il tuo Ollama** quando i log mostrano traffico cloud-only

Il gateway ha auto-migration nel parser catalog: se trova un campo `upstream` (legacy v0.2) lo mappa al primo provider configurato in `UPSTREAM_PROVIDERS`. Quindi anche senza modificare il catalog la transizione è zero-downtime.

## TL;DR

**Tu hai un GPU debole. Production reale = compute sul cloud, gateway sul VPS, fatturi ai clienti, paghi i provider, intaschi il margine. Il tuo PC non è MAI nel critical path.**
