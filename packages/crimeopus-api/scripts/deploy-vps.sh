#!/usr/bin/env bash
# deploy-vps.sh — installa il gateway CrimeOpus API su un VPS Ubuntu/Debian
#                 fresco di setup, idempotente, < 60 secondi.
#
# Cosa fa (in ordine):
#   1. Installa Bun (se mancante)
#   2. Crea un utente di sistema 'crimeopus' senza shell
#   3. Clona / aggiorna il repo
#   4. Installa dipendenze
#   5. Genera systemd unit
#   6. Installa Caddy con TLS automatico verso un dominio
#   7. Apre porte firewall (ufw)
#   8. Avvia servizi
#
# Run on the VPS as root:
#   curl -fsSL https://raw.githubusercontent.com/.../deploy-vps.sh | sudo bash -s -- api.tuodominio.dev
#
# Or locally:
#   scp -r packages/crimeopus-api root@vps:/tmp/
#   ssh root@vps "bash /tmp/crimeopus-api/scripts/deploy-vps.sh api.tuodominio.dev"

set -euo pipefail

DOMAIN="${1:-}"
APP_USER="crimeopus"
APP_HOME="/opt/crimeopus-api"
ENV_FILE="/etc/crimeopus-api.env"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <domain>"
  echo "Example: $0 api.crimeopus.dev"
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root (or with sudo)"
  exit 1
fi

log() { echo -e "\033[1;36m▶\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }
warn(){ echo -e "\033[1;33m⚠\033[0m $*"; }

# ── 1. Install Bun ─────────────────────────────────────────────
log "Checking Bun runtime…"
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  cp /root/.bun/bin/bun /usr/local/bin/bun
  ok "Bun installed: $(bun --version)"
else
  ok "Bun already installed: $(bun --version)"
fi

# ── 2. Create system user ──────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating system user $APP_USER…"
  useradd --system --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
  ok "User $APP_USER created"
else
  ok "User $APP_USER exists"
fi

mkdir -p "$APP_HOME"
chown -R "$APP_USER:$APP_USER" "$APP_HOME"

# ── 3. Sync code ───────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log "Syncing code from $PACKAGE_DIR → $APP_HOME"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .env --exclude usage.db \
  --exclude '.git*' \
  "$PACKAGE_DIR/" "$APP_HOME/"
chown -R "$APP_USER:$APP_USER" "$APP_HOME"
ok "Code synced"

# ── 4. Install deps ────────────────────────────────────────────
log "Installing dependencies…"
sudo -u "$APP_USER" bash -c "cd $APP_HOME && bun install --production"
ok "Dependencies installed"

# ── 5. Env file ────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$APP_HOME/.env" ]]; then
    cp "$APP_HOME/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "Copied .env → $ENV_FILE (mode 600)"
  else
    log "No .env found — creating template at $ENV_FILE"
    cp "$APP_HOME/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    warn "Edit $ENV_FILE: imposta UPSTREAM_PROVIDERS, ADMIN_PASSWORD, JWT_SECRET, API_KEYS"
    warn "Poi riesegui questo script o:  systemctl restart crimeopus-api"
  fi
fi

# ── 6. systemd unit ────────────────────────────────────────────
log "Installing systemd unit…"
cat > /etc/systemd/system/crimeopus-api.service <<UNIT
[Unit]
Description=CrimeOpus API Gateway
Documentation=https://github.com/samupae2300-star/CrimeCode-IDE/tree/main/packages/crimeopus-api
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_HOME
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/bun run $APP_HOME/src/index.ts
Restart=on-failure
RestartSec=5s
TimeoutStopSec=10s

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$APP_HOME
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native

# Logging
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable crimeopus-api
ok "systemd unit installed (crimeopus-api.service)"

# ── 7. Caddy reverse proxy ─────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy…"
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
  ok "Caddy installed"
else
  ok "Caddy already installed"
fi

log "Configuring Caddy reverse proxy for $DOMAIN…"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
    encode zstd gzip

    # Block /admin from public internet — uncomment if you want admin
    # only via SSH tunnel:
    # @admin path /admin*
    # respond @admin "use SSH tunnel" 403

    log {
        output file /var/log/caddy/$DOMAIN.log {
            roll_size 100mb
            roll_keep 5
        }
        format json
    }
}
CADDY

systemctl reload caddy
ok "Caddy configured for $DOMAIN (TLS auto via Let's Encrypt)"

# ── 8. Firewall ────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  log "Configuring firewall (ufw)…"
  ufw allow 22/tcp comment "ssh" >/dev/null
  ufw allow 80/tcp comment "http (caddy auto-cert)" >/dev/null
  ufw allow 443/tcp comment "https" >/dev/null
  ufw --force enable >/dev/null 2>&1 || true
  ok "Firewall: 22/80/443 allowed"
fi

# ── 9. Start ───────────────────────────────────────────────────
log "Starting crimeopus-api…"
systemctl restart crimeopus-api
sleep 2
if systemctl is-active --quiet crimeopus-api; then
  ok "Service running"
else
  warn "Service failed to start — check: journalctl -u crimeopus-api -n 50"
fi

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploy completo"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "  Endpoint pubblico: https://$DOMAIN"
echo "  Healthcheck:       curl https://$DOMAIN/healthz"
echo "  Admin dashboard:   https://$DOMAIN/admin"
echo
echo "  Tail logs:         journalctl -u crimeopus-api -f"
echo "  Restart:           systemctl restart crimeopus-api"
echo "  Edit env:          \$EDITOR $ENV_FILE  &&  systemctl restart crimeopus-api"
echo
echo "  Test cURL (sostituisci sk-... con la tua test key):"
echo "    curl -H 'Authorization: Bearer sk-xxx' https://$DOMAIN/v1/models"
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
