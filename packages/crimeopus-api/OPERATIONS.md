# Operations runbook (post-deploy)

Guida operativa per le attività **dopo** che `bun run provision:hetzner`
ha terminato. L'ordine consigliato è:

1. ✅ **Volume separato per usage.db** — già configurato (vedi sezione 1)
2. **UptimeRobot** — monitoring esterno gratuito (5 min)
3. **Slack webhook** — alert quota / provider failover (5 min)
4. **Multi-region HA** — secondo VPS USA + Cloudflare geo-steering (15 min, +€5/mese)
5. **Backup automatici Hetzner** — €0.76/mese, 1 click su console

---

## 1. Volume separato per `usage.db` ✅ (configurato)

Lo stato attuale del VPS produzione è il seguente:

| Path | Volume | Persistente al riavvio | Persistente al resize |
|---|---|---|---|
| `/opt/crimeopus-api/` | disk root (sda) | sì | **NO** (re-deploy lo sovrascrive) |
| `/etc/crimeopus-api.env` | disk root (sda) | sì | sì (preservato dal deploy) |
| `/mnt/crimeopus-data/db/usage.db` | **volume Hetzner (sdb)** | sì | sì |

Il DB metriche (`usage.db`) sopravvive ora a:
- Re-deploy del codice (`bun run provision:hetzner -- --reuse-server`)
- Resize del VPS (Hetzner upgrade in-place)
- Reinstallazione completa (basta riattaccare il volume al nuovo server)

**Costo:** €0.40/mese (10 GB × €0.04/GB).

**Verifica live:**
```bash
ssh -i ~/.ssh/crimeopus_ed25519 root@65.109.140.176 \
  'df -h /mnt/crimeopus-data && ls -la /mnt/crimeopus-data/db/'
```

**In caso il volume si stacchi (es. resize VPS):**
```bash
# 1. Riattacca il volume tramite Hetzner Console (Volumes → Attach to server)
# 2. Riavvia il servizio
ssh -i ~/.ssh/crimeopus_ed25519 root@65.109.140.176 \
  'mount /mnt/crimeopus-data && systemctl restart crimeopus-api'
```

Il mount è già in `/etc/fstab` con `nofail`: il sistema bootta anche se il
volume non è attaccato (servizio fallirà ma SSH/Caddy resteranno su).

---

## 2. UptimeRobot (monitoring esterno gratuito)

UptimeRobot pinga `https://ai.crimecode.cc/healthz` ogni 5 minuti da
diverse location nel mondo, e ti manda un'email/push/Slack se il
servizio è down.

Tier free: **50 monitor a 5 min**. Sufficiente per tutto il setup.

### Setup (3 minuti)

1. Crea account: https://uptimerobot.com/signUp (basta email)

2. Conferma email, poi **Add New Monitor**:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** `CrimeOpus API healthz`
   - **URL:** `https://ai.crimecode.cc/healthz`
   - **Monitoring Interval:** `5 minutes` (free tier)
   - **HTTP Method:** GET
   - **Keyword Monitoring:** abilita → cerca `"ok":true`
     (così se Caddy risponde 200 ma il backend è morto, lo capisce)

3. **Alert Contacts** → aggiungi:
   - Email primaria (default)
   - (Opzionale) Slack webhook (vedi sezione 3 sotto: stesso URL)
   - (Opzionale) Push su iOS/Android (app gratuita)

4. **Status Page pubblica** (gratis):
   - Sidebar → **Status Pages** → **New Status Page**
   - URL `crimeopus.uptime-robot.com` (puoi cambiarlo)
   - Aggiungi il monitor `CrimeOpus API healthz`
   - Condividi link con clienti / membri team

### Aggiungi un secondo monitor opzionale per `/v1/models`

Se vuoi essere certo che anche l'API auth funzioni (non solo Caddy):
- **URL:** `https://ai.crimecode.cc/v1/models`
- **HTTP Method:** GET
- **Custom HTTP Headers:** `Authorization: Bearer sk-test-crimeopus-2026` (o una read-only key dedicata)
- **Keyword:** `crimeopus-default`

⚠️ Crea una API key dedicata read-only per questo monitor (vedi
`/admin → Keys → New`) invece di usare la chiave principale.

---

## 3. Slack webhook per quota / failover alerts

Il gateway invia alert HMAC-firmati a webhook esterni quando:
- Una API key supera la quota mensile (`quota.exceeded`)
- Un provider upstream va in unhealthy (`provider.down`)
- Il deploy parte (`deploy.start`) e finisce (`deploy.complete`)

### Step 1 — Crea Slack Incoming Webhook

1. https://api.slack.com/apps → **Create New App** → **From scratch**
   - App Name: `CrimeOpus Alerts`
   - Workspace: il tuo
2. **Incoming Webhooks** → **Activate** → **Add New Webhook to Workspace**
3. Scegli il canale (es. `#crimeopus-alerts`)
4. Copia l'URL (formato: `https://hooks.slack.com/services/T.../B.../...`)

### Step 2 — Registra il webhook nel gateway

Il gateway non parla Slack format direttamente — usa un piccolo proxy
Cloudflare Worker o un endpoint Vercel per tradurre il payload HMAC in
un messaggio Slack-friendly. **Setup più semplice (10 righe Worker):**

```js
// cloudflare-worker.js — copy-paste su workers.cloudflare.com
const SLACK = "https://hooks.slack.com/services/T.../B.../..."  // ← incolla qui

export default {
  async fetch(req) {
    const body = await req.json()
    const txt = body.event === "quota.exceeded"
      ? `:warning: Quota exceeded — *${body.tenant}* used ${body.used}/${body.limit}`
      : body.event === "provider.down"
      ? `:rotating_light: Provider DOWN — ${body.provider} (${body.reason})`
      : `:information_source: ${body.event}`
    await fetch(SLACK, {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({text: txt}),
    })
    return new Response("ok")
  }
}
```

Deploy con `wrangler deploy` o tramite l'editor web di Cloudflare → ottieni
URL `https://crimeopus-slack.<your-account>.workers.dev`.

### Step 3 — Registra il webhook nel DB del gateway

Tunnel SSH per accedere a `/admin`:
```bash
ssh -i ~/.ssh/crimeopus_ed25519 -L 8787:localhost:8787 root@65.109.140.176 -N
```

In un'altra terminale, autenticati:
```bash
ADMIN_PASS=admin-crimeopus-2026

curl -u admin:$ADMIN_PASS http://localhost:8787/admin/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://crimeopus-slack.<your-account>.workers.dev",
    "events": ["quota.exceeded","provider.down","deploy.complete"],
    "secret": "auto"
  }'
```

Risposta (esempio):
```json
{ "id": 1, "url": "...", "secret": "wh_xxxxx...", "events": [...] }
```

⚠️ Salva il `secret` restituito — l'utente che riceve il webhook lo userà
per validare la firma `X-CrimeOpus-Signature` se vuole.

### Step 4 — Test

```bash
curl -u admin:$ADMIN_PASS http://localhost:8787/admin/api/webhooks/1/test \
  -X POST
```

Su Slack dovresti vedere un messaggio di test entro 1-2 secondi.

### Eventi disponibili

| Evento | Quando | Payload chiave |
|---|---|---|
| `quota.exceeded` | API key supera quota mensile | `tenant`, `key`, `used`, `limit` |
| `quota.warning` | 80% della quota usato | `tenant`, `key`, `used`, `limit`, `remaining` |
| `provider.down` | Provider fail health 3× consecutivi | `provider`, `reason`, `since` |
| `provider.recovered` | Provider torna healthy | `provider`, `down_for_seconds` |
| `deploy.start` | `provision-hetzner.ts` inizia | `version`, `commit` |
| `deploy.complete` | Deploy completato | `version`, `commit`, `duration_ms` |
| `key.created` | Nuova API key creata | `tenant`, `label`, `quota` |

---

## 4. Multi-region HA (secondo VPS USA)

Per servire utenti USA/West Coast con latenza <30ms invece di 100-150ms
da Helsinki, provisiona un secondo VPS in Ashburn (USA East) e configura
Cloudflare Load Balancer per geo-steering.

**Costo addizionale:** €4.87 (VPS cx23) + €0.40 (volume 10GB) = **€5.27/mese**

### Setup

#### Step 1 — Provisiona secondo VPS

```bash
cd packages/crimeopus-api

HETZNER_TOKEN=$HETZNER_TOKEN \
CF_TOKEN=$CF_TOKEN \
CF_ZONE_ID=$CF_ZONE_ID \
  bun run provision:hetzner -- \
    --name crimeopus-api-us \
    --location ash \
    --domain us.ai.crimecode.cc
```

(usa lo stesso `.env` locale → Together/Groq/JWT identici, così le API
key sono valide su entrambi i pod)

Al termine avrai 2 endpoint:
- `https://ai.crimecode.cc` (Helsinki) — già attivo
- `https://us.ai.crimecode.cc` (Ashburn) — nuovo

#### Step 2 — (consigliato) Volume usage.db anche sul VPS USA

Ripeti la procedura `OPERATIONS.md §1` puntando al nuovo VPS:
```bash
# Crea volume in ash
curl -X POST -H "Authorization: Bearer $HETZNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"size":10,"name":"crimeopus-data-us","location":"ash","format":"ext4"}' \
  https://api.hetzner.cloud/v1/volumes
# → annota volume.id
```

Poi attacca dal Hetzner Console → server `crimeopus-api-us` → Volumes →
Attach. Lo script di mount è identico.

#### Step 3 — Cloudflare Load Balancer (geo-steering)

Nel pannello Cloudflare:

1. **Traffic** → **Load Balancing** → **Create Load Balancer**
   - Hostname: `ai.crimecode.cc`
   - Session Affinity: `None` (gateway è stateless)
   - Steering Policy: `Geo-steering`

2. **Origins** → aggiungi 2 origin:
   - `eu-pool`: `65.109.140.176` (IP del VPS hel1) — **Health check:** `https://ai.crimecode.cc/healthz`, expected `200` con keyword `"ok":true`
   - `us-pool`: `<IP del VPS ash>` — **Health check:** `https://us.ai.crimecode.cc/healthz`

3. **Geo-Steering Rules:**
   - Continent `EU` → `eu-pool`
   - Continent `AF` → `eu-pool` (Africa più vicina a EU)
   - Continent `AS` → `eu-pool` (sì, anche per Asia: hel1 è geograficamente più vicino di ash al medio oriente)
   - Continent `NA`, `SA` → `us-pool`
   - Continent `OC` → `us-pool` (Oceania più vicina a US west, ma ash funziona)
   - Default: `eu-pool` (fallback)

4. **Failover automatico:**
   - Cloudflare invia richieste al pool primario; se fail health (3 fail
     consecutivi a 30s di intervallo) ruota tutto traffico sull'altro
     pool entro 90 secondi
   - Quando il primario torna healthy, il traffico si redistribuisce

#### Step 4 — DNS

Cloudflare crea automaticamente un CNAME virtuale `ai.crimecode.cc → <load-balancer>`.
Verifica:
```bash
dig +short ai.crimecode.cc
# Dovresti vedere 2 IP (LB Cloudflare) NON gli IP dei VPS direttamente
```

#### Step 5 — Test failover

```bash
# Da Italia (dovrebbe colpire hel1):
curl -s https://ai.crimecode.cc/healthz | jq '.region'  # → "hel1"

# Spegni hel1:
ssh -i ~/.ssh/crimeopus_ed25519 root@65.109.140.176 'systemctl stop crimeopus-api'

# Aspetta 90s, poi:
curl -s https://ai.crimecode.cc/healthz | jq '.region'  # → "ash" (failover)

# Riaccendi:
ssh -i ~/.ssh/crimeopus_ed25519 root@65.109.140.176 'systemctl start crimeopus-api'
# Dopo ~30-60s torna su hel1
```

⚠️ Per esporre `region` nell'output di `/healthz` devi settare `REGION=hel1`
e `REGION=ash` nei rispettivi `/etc/crimeopus-api.env`. Non è strettamente
necessario, è solo per debug del failover.

---

## 5. Backup Hetzner (€0.76/mese)

Backup automatici giornalieri retention 7 giorni, 1-click setup:

1. Hetzner Console → server `crimeopus-api` → **Backups** tab → **Enable**
2. Costo: 20% del prezzo del server = €0.97 per cx23 (€4.87 × 20%)
3. Snapshot includono: disco root + tutti i volumi attaccati (quindi
   anche `usage.db` sul volume `crimeopus-data` viene backuppato)

Restore: console → Backups → seleziona snapshot → **Rebuild from backup**.
Crea un nuovo server con lo stesso stato. Cambia IP, devi aggiornare DNS.

---

## Cleanup completo (distruzione)

⚠️ Distrugge **TUTTO** inclusi backup e usage.db. Irreversibile.

```bash
# 1. Sblocca volume (deve essere detachato prima di delete)
HETZNER_TOKEN=xxx
SERVER_ID=$(curl -s -H "Authorization: Bearer $HETZNER_TOKEN" \
  "https://api.hetzner.cloud/v1/servers?name=crimeopus-api" | jq '.servers[0].id')
VOLUME_ID=$(curl -s -H "Authorization: Bearer $HETZNER_TOKEN" \
  "https://api.hetzner.cloud/v1/volumes?name=crimeopus-data" | jq '.volumes[0].id')

curl -X POST -H "Authorization: Bearer $HETZNER_TOKEN" \
  https://api.hetzner.cloud/v1/volumes/$VOLUME_ID/actions/detach

# 2. Elimina volume
curl -X DELETE -H "Authorization: Bearer $HETZNER_TOKEN" \
  https://api.hetzner.cloud/v1/volumes/$VOLUME_ID

# 3. Elimina server
curl -X DELETE -H "Authorization: Bearer $HETZNER_TOKEN" \
  https://api.hetzner.cloud/v1/servers/$SERVER_ID

# 4. Elimina DNS A record da Cloudflare
# (manuale: dashboard Cloudflare → DNS → cestina record `api`)
```
