#!/usr/bin/env bash
# register-modal-in-gateway.sh — aggiunge il Modal endpoint come provider
#                                primary di crimeopus-agentic nel gateway.
#
# Usage:
#   bash register-modal-in-gateway.sh https://<user>--crimeopus-uncensored-serve.modal.run
#
# Cosa fa:
#   1. Aggiunge "modal-uncensored" al UPSTREAM_PROVIDERS env in /etc/crimeopus-api.env
#      con weight=1 maxInflight=20 (vLLM batching robusto)
#   2. Riordina catalog di crimeopus-agentic: modal primary, together failover, groq last
#   3. Restart gateway
#   4. Smoke test
#   5. Rinomina il modello user-side in "FullUncensored — Modal (Huihui-…abliterated)"

set -euo pipefail

MODAL_URL="${1:-}"
GATEWAY_HOST="${GATEWAY_HOST:-root@65.109.140.176}"
GATEWAY_KEY="${GATEWAY_KEY:-$HOME/.ssh/crimeopus_ed25519}"

if [[ -z "$MODAL_URL" ]]; then
  echo "Usage: $0 <modal-endpoint-url>"
  echo "Esempio: $0 https://jollyfraud--crimeopus-uncensored-serve.modal.run"
  exit 1
fi

# strip eventual trailing slash; accept already-/v1 or root
MODAL_URL="${MODAL_URL%/}"
if [[ "$MODAL_URL" != */v1 ]]; then
  MODAL_URL="$MODAL_URL"  # the ASGI app exposes /v1/* directly at root
fi

ssh_remote() { ssh -i "$GATEWAY_KEY" -o BatchMode=yes "$GATEWAY_HOST" "$@"; }

echo "▶ Pre-flight: ping del Modal endpoint"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 "$MODAL_URL/health" || echo 000)
case "$HTTP" in
  200) echo "  ✓ Modal /health risponde HTTP 200" ;;
  *)   echo "  ⚠ /health HTTP=$HTTP — può essere cold start, procedo comunque" ;;
esac
echo

echo "▶ Aggiungo provider 'modal-uncensored' al gateway"
ssh_remote "python3 - <<'PYEOF'
import json, os, re
env = '/etc/crimeopus-api.env'
src = open(env).read()
m = re.search(r'^(UPSTREAM_PROVIDERS=)(.+)\$', src, re.MULTILINE | re.DOTALL)
if not m:
    print('✗ UPSTREAM_PROVIDERS non trovato in /etc/crimeopus-api.env'); raise SystemExit(1)
raw = m.group(2).strip().strip(\"'\").strip('\"')
providers = json.loads(raw)
# rimuovi eventuale modal-uncensored vecchio
providers = [p for p in providers if p.get('id') != 'modal-uncensored']
# aggiungi nuovo
providers.append({
    'id': 'modal-uncensored',
    'kind': 'openai',
    'url': '$MODAL_URL/v1',
    'apiKey': '',
    'weight': 1,
    'maxInflight': 20,
    'healthUrl': '$MODAL_URL/health',
})
new_raw = json.dumps(providers, separators=(',', ':'))
new = src[:m.start(2)] + \"'\" + new_raw + \"'\" + src[m.end(2):]
open(env, 'w').write(new)
print('  ✓ provider aggiunto')
PYEOF"
echo

echo "▶ Aggiorno catalog: modal-uncensored primary di crimeopus-agentic"
ssh_remote "python3 - <<'PYEOF'
import json
path = '/opt/crimeopus-api/catalog.json'
c = json.load(open(path))
c['crimeopus-agentic']['providers'] = [
  {'provider': 'modal-uncensored', 'model': 'crimeopus-agentic'},
  {'provider': 'together', 'model': 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput'},
  {'provider': 'groq', 'model': 'llama-3.3-70b-versatile'},
]
c['crimeopus-agentic']['description'] = (
    'Modello uncensored abliterated — Huihui-Qwen3.6-35B su Modal H100 '
    '(scale-to-zero). Failover: Qwen3-235B (Together) → Llama-3.3-70B (Groq).'
)
open(path, 'w').write(json.dumps(c, indent=2, ensure_ascii=False))
print('  ✓ catalog aggiornato')
PYEOF"
echo

echo "▶ Restart gateway"
ssh_remote "systemctl restart crimeopus-api && sleep 3 && systemctl is-active crimeopus-api"
echo

echo "▶ Smoke test via gateway → Modal"
curl -sS https://ai.crimecode.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-test-crimeopus-2026" \
  -H "Content-Type: application/json" \
  -d '{"model":"crimeopus-agentic","messages":[{"role":"user","content":"di solo: ok"}],"max_tokens":5}' \
  --max-time 240 -w "\n  HTTP: %{http_code}  elapsed: %{time_total}s\n" | head -c 600
echo
echo

echo "▶ Rinomino il modello user-side (FullUncensored — Modal)"
NEW_NAME="CrimeOpus AGENTIC FullUncensored — Modal (Huihui-Qwen3.6-35B abliterated)"
for F in \
  "$HOME/.config/opencode/opencode.jsonc" \
  "$HOME/.opencode/opencode.jsonc" \
  "$HOME/.openworm/opencode.jsonc"; do
  if [ -f "$F" ]; then
    sed -i "s|\"CrimeOpus AGENTIC[^\"]*\"|\"$NEW_NAME\"|" "$F"
    echo "  ✓ $F"
  fi
done
# LOCALAPPDATA path su Windows MSYS/Git Bash
LA="${LOCALAPPDATA:-$HOME/AppData/Local}"
if [ -f "$LA/openworm/opencode.jsonc" ]; then
  sed -i "s|\"CrimeOpus AGENTIC[^\"]*\"|\"$NEW_NAME\"|" "$LA/openworm/opencode.jsonc"
  echo "  ✓ $LA/openworm/opencode.jsonc"
fi

echo
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  ✓ Setup completo. Riavvia OpenCode Desktop.                  ║"
echo "║  Il modello AGENTIC ora gira sul Huihui abliterated via       ║"
echo "║  Modal scale-to-zero. Idle: \$0/h. Attivo: ~\$1.95/h H100.    ║"
echo "║  Cold start primo uso: ~2-3 min (download 17GB su HF cache).  ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
