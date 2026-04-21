# Configurazione Starlink per Port Forwarding

## Il Problema

I router Starlink **non hanno un'interfaccia web** per configurare il port forwarding. La gestione avviene tramite:

1. **App Starlink** (Android/iOS) - Consigliato
2. **Modalità Bypass** - Per usare il tuo router

---

## Opzione 1: Usa l'App Starlink (Consigliata)

### Passi:

1. **Scarica l'app Starlink** dal Play Store / App Store

2. **Connettiti al WiFi Starlink**

3. **Vai su Settings** (⚙️) → **Advanced** → **Port Forwarding**

4. **Aggiungi le regole:**
   - Nome: `OpenCode Relay`
   - Porta: `3747`
   - Protocollo: `TCP`
   - Nome: `OpenCode Server`
   - Porta: `56912`
   - Protocollo: `TCP`

---

## Opzione 2: Modalità Bypass (Router Esterno)

Se preferisci usare il port forwarding tradizionale:

### Passi:

1. **Disabilita il WiFi Starlink** o usa la porta **BYPASS**

2. **Collega il tuo router** alla porta "BYPASS" dello Starlink

3. **Configura il port forwarding** sul tuo router (standard 192.168.1.1)

4. **I PC sulla rete avranno IP tipo:** `192.168.x.x`

---

## Opzione 3: Alternative Senza Port Forwarding

Se non riesci a configurare Starlink, usa **ngrok** (più facile):

### Installa ngrok:

1. Vai su https://ngrok.com/download
2. Estrai e registra gratis
3. Esegui:

```bash
# Terminale 1 - Server
ngrok http 56912

# Ti darà un URL tipo:
# https://abc123.ngrok.io
```

### Poi nel Desktop App:

- URL: `https://abc123.ngrok.io` (quello che ngrok ti dà)
- Usa l'URL pubblico invece dell'IP

---

## Come verificare se funziona

```bash
# Test relay
curl http://212.105.155.6:3747/health

# Test server
curl http://212.105.155.6:56912/
```

---

## Consiglio Rapido

**Scarica l'app Starlink** - è il modo più semplice per configurare il router Starlink.

L'app permette:

- Port forwarding
- Gestione dispositivi
- Statistiche di rete
- Parental controls
