# VPS provisioning automatico (60 secondi)

Script Bun che provisiona un VPS pronto in produzione con un comando.
Auto-genera SSH keys, crea il VPS, configura DNS, esegue il deploy
completo (Bun + systemd + Caddy + ufw + TLS Let's Encrypt).

## Quick start

### 1. Account Hetzner Cloud

1. Vai su https://accounts.hetzner.com/signUp
2. Conferma email + carta (richiede verifica €1, restituiti)
3. https://console.hetzner.cloud → crea un progetto **CrimeOpus**
4. Nel progetto: **Security → API Tokens → Generate API token**
   - Permessi: **Read & Write**
   - Salva il token (es. `hcloud-XXXX...`)

### 2. (Opzionale) Cloudflare per DNS automatico

Se hai un dominio su Cloudflare:

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token**
2. Template: **Edit zone DNS**
3. Zone Resources: **Specific zone** → seleziona il tuo dominio
4. Salva il token (`cf-XXXX...`)
5. **Zone ID**: vai sul dominio → Overview → in basso a destra c'è lo Zone ID

Se NON usi Cloudflare: dovrai aggiungere manualmente il record DNS A
quando lo script lo chiederà (lo script stamperà comunque l'IP).

### 3. Avvia il provisioning

```bash
cd packages/crimeopus-api

# Setup .env locale prima (se non l'hai già)
bun run setup
# (oppure copia .env.example e edita)

# Provisioning
HETZNER_TOKEN=hcloud-xxxxxxxxxxxxxx \
CF_TOKEN=cf-xxxxxxxxxxxxxxxxxxxx \
CF_ZONE_ID=zone-xxxxxxxxxxxxxxxx \
  bun run provision:hetzner -- --domain api.tuodominio.dev

# Senza Cloudflare:
HETZNER_TOKEN=hcloud-xxx \
  bun run provision:hetzner -- --domain api.tuodominio.dev --skip-dns
```

Lo script fa **tutto da solo**:

```
[1] SSH keypair locale
    ✓ keypair created → ~/.ssh/crimeopus_ed25519

[2] Carica SSH key su Hetzner
    ✓ SSH key creata: id=12345

[3] Provisiona VPS (type=cx22 location=hel1 image=ubuntu-24.04)
    ✓ server creato: id=67890

[4] Attendi che il VPS sia running + SSH raggiungibile
    waiting… status=running ip=65.108.x.x
    ✓ SSH ready

[5] DNS Cloudflare: api.tuodominio.dev A 65.108.x.x
    ✓ DNS A record creato

[6] rsync del pacchetto crimeopus-api → VPS
    ✓ codice copiato
    ✓ .env caricato in /tmp/crimeopus-api.env

[7] Esegui deploy-vps.sh sul VPS
    ▶ Installing Bun runtime…
    ✓ Bun installed
    ✓ User crimeopus created
    ✓ Code synced
    ✓ Dependencies installed
    ✓ systemd unit installed
    ✓ Caddy installed + configured
    ✓ Firewall: 22/80/443 allowed
    ✓ Service running

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Provisioning completo
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  VPS:        crimeopus-api (cx22 @ hel1)
  IP:         65.108.x.x
  Domain:     api.tuodominio.dev
  SSH:        ssh -i ~/.ssh/crimeopus_ed25519 root@65.108.x.x

  Endpoints:
    https://api.tuodominio.dev/healthz       (no auth)
    https://api.tuodominio.dev/v1/models     (Bearer auth)
    https://api.tuodominio.dev/admin         (basic auth via tunnel SSH)

  Costo mensile stimato: €3.79/mese (Hetzner CX22)
```

## Tier sizing

```bash
# Default — 50-500 utenti
--type cx22       # 2 vCPU, 4 GB RAM, €3.79/mese

# Production seria — 500-5k utenti
--type ccx13      # 2 vCPU dedicati, 8 GB RAM, €12.49/mese

# Heavy — 5k-50k utenti
--type ccx23      # 4 vCPU dedicati, 16 GB RAM, €24.49/mese
```

Tutti gli upgrade sono in-place (1 click su Hetzner Cloud Console),
nessun downtime perché `.env` è in `/etc/crimeopus-api.env` (volume
preserved durante resize).

## Locations Hetzner

```bash
--location hel1   # Helsinki — latenza Italia ~30ms (raccomandato)
--location nbg1   # Norimberga — ~25ms
--location fsn1   # Falkenstein — ~25ms
--location ash    # Ashburn USA — per clienti USA
--location hil    # Hillsboro USA — per clienti West Coast
```

## Modalità avanzate

### Riusa un server esistente
```bash
# Se hai già un server "crimeopus-api" e vuoi solo aggiornare il codice
bun run provision:hetzner -- --reuse-server --domain api.tuodominio.dev
```

### Solo provision, no deploy code
```bash
# Crea il VPS ma non copiare il codice (gestisci tu deploy)
bun run provision:hetzner -- --domain api.tuodominio.dev --skip-deploy
```

### Dry run (no cost incurred)
```bash
bun run provision:hetzner -- --domain api.tuodominio.dev --dry-run
```

### Multi-region (alta disponibilità)
Crea 2 VPS in location diverse:
```bash
bun run provision:hetzner -- --name crimeopus-eu --location hel1 --domain eu.api.tuodominio.dev
bun run provision:hetzner -- --name crimeopus-us --location ash  --domain us.api.tuodominio.dev
```
Poi su Cloudflare attiva **Geo Steering** per indirizzare ogni utente al VPS più vicino.

## Cose che lo script NON fa (da fare a mano)

1. **Backup automatici** — abilita su Hetzner Cloud Console:
   `Server → crimeopus-api → Backups → Enable` (€0.76/mese, 7 giorni)
2. **Volume separato per usage.db** — se vuoi che le metriche sopravvivano
   a re-deploy / resize: crea un Hetzner Volume e mountalo su `/var/lib/crimeopus`
3. **Monitoring esterno** — registrati a Hetzner Cloud Monitoring (gratis)
   o https://www.uptimerobot.com (free tier 50 monitor 5min)
4. **Pruning log** — `journalctl --vacuum-size=100M` ogni mese (cron)

## Troubleshooting

| Errore | Soluzione |
|---|---|
| `HETZNER_TOKEN not found` | export prima di eseguire lo script |
| `SSH non risponde entro 90s` | il VPS sta ancora bootando — aspetta 1 min e rilancia con `--reuse-server` |
| `Caddy: no such host` | DNS non ha propagato — aspetta 1-5 min e fai `systemctl reload caddy` |
| `crimeopus-api.service failed` | controlla `/etc/crimeopus-api.env` — `journalctl -u crimeopus-api -n 50` |
| `Hetzner: rate_limit` | API token con quota troppo bassa, aspetta 60s |

## Cleanup

Quando vuoi distruggere tutto:

```bash
# Trova l'ID del server
HETZNER_TOKEN=xxx curl -H "Authorization: Bearer $HETZNER_TOKEN" \
  https://api.hetzner.cloud/v1/servers?name=crimeopus-api | jq '.servers[0].id'

# Elimina (irreversible — perdi anche usage.db!)
curl -X DELETE -H "Authorization: Bearer $HETZNER_TOKEN" \
  https://api.hetzner.cloud/v1/servers/<ID>
```
