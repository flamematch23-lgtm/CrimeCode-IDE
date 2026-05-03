#!/usr/bin/env bash
# restore-runpod-uncensored.sh — esegui DOPO aver fatto top-up >= $5 su RunPod.
#
# Cosa fa, in ordine:
#   1. Verifica che il saldo RunPod sia almeno $5
#   2. Crea un nuovo Network Volume da 100GB nel datacenter scelto
#      (default EU-NL-1 — H100 stock vicino al gateway Iceland)
#   3. Aggiorna il profilo AWS S3 locale `runpods3` puntando all'endpoint
#      S3 del nuovo datacenter
#   4. Attacca il volume all'endpoint serverless ng6965hlqcd6bu
#   5. Refresh dei worker (max 0 → max 3)
#   6. Pre-warm: chiama il modello, attende che il volume riempia (~17 GB
#      per Huihui-Qwen3.6-35B-A3B-...-abliterated-NVFP4)
#   7. Aggiorna il catalog del gateway crimeopus-api: rimette runpod come
#      provider PRIMARY di crimeopus-agentic, restart del gateway
#   8. Rinomina il modello agentic nei 4 config user-globali aggiungendo
#      di nuovo "FullUncensored" perché ORA è davvero il modello abliterated
#   9. Smoke test finale via gateway
#
# Override:
#   DATACENTER=EU-NL-1   altri: US-OR-1, US-CA-2, EUR-IS-3, EU-RO-1, ...
#   VOLUME_GB=100        size del volume in GB
#   ENDPOINT_ID=ng6965hlqcd6bu   ID dell'endpoint serverless
#   GATEWAY_HOST=root@65.109.140.176   SSH del gateway VPS
#   GATEWAY_KEY=~/.ssh/crimeopus_ed25519   chiave SSH

set -euo pipefail

DATACENTER="${DATACENTER:-EU-NL-1}"
VOLUME_GB="${VOLUME_GB:-100}"
ENDPOINT_ID="${ENDPOINT_ID:-ng6965hlqcd6bu}"
GATEWAY_HOST="${GATEWAY_HOST:-root@65.109.140.176}"
GATEWAY_KEY="${GATEWAY_KEY:-$HOME/.ssh/crimeopus_ed25519}"

# Datacenter → S3 endpoint mapping
declare -A S3_ENDPOINTS=(
  [EUR-IS-1]="https://s3api-eur-is-1.runpod.io"
  [EUR-IS-3]="https://s3api-eur-is-3.runpod.io"
  [EU-NL-1]="https://s3api-eu-nl-1.runpod.io"
  [EU-RO-1]="https://s3api-eu-ro-1.runpod.io"
  [US-OR-1]="https://s3api-us-or-1.runpod.io"
  [US-CA-2]="https://s3api-us-ca-2.runpod.io"
  [US-KS-2]="https://s3api-us-ks-2.runpod.io"
)

S3_ENDPOINT="${S3_ENDPOINTS[$DATACENTER]:-https://s3api-${DATACENTER,,}.runpod.io}"

ssh_remote() { ssh -i "$GATEWAY_KEY" -o BatchMode=yes "$GATEWAY_HOST" "$@"; }

# ── 0. ssh-agent fingerprint check ───────────────────────────────
if ! ssh_remote "true" 2>/dev/null; then
  echo "✗ SSH al gateway $GATEWAY_HOST fallito. Imposta GATEWAY_KEY/GATEWAY_HOST."
  exit 1
fi

RP_KEY=$(ssh_remote 'grep -oE "\"runpod\"[^}]+" /etc/crimeopus-api.env | grep -oE "\"apiKey\":\"[^\"]+\"" | sed "s/.*:\"//;s/\"//"')
[ -z "$RP_KEY" ] && { echo "✗ runpod apiKey non trovata in /etc/crimeopus-api.env"; exit 1; }

# ── 1. saldo RunPod >= $5 ───────────────────────────────────────
echo "▶ Verifica saldo RunPod…"
BALANCE=$(curl -sS https://api.runpod.io/graphql \
  -H "Authorization: Bearer $RP_KEY" -H "Content-Type: application/json" \
  -d '{"query":"query { myself { minBalance currentSpendPerHr machineQuota } }"}' \
  --max-time 15 | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['myself']['minBalance'])")
echo "  saldo: \$$BALANCE"
if (( $(echo "$BALANCE < 5" | bc -l) )); then
  echo "✗ Saldo < \$5. Top-up su https://www.runpod.io/console/user/billing"
  exit 1
fi

# ── 2. crea volume ─────────────────────────────────────────────
echo "▶ Creo volume ${VOLUME_GB}GB in $DATACENTER…"
VOL_RESP=$(curl -sS -X POST https://rest.runpod.io/v1/networkvolumes \
  -H "Authorization: Bearer $RP_KEY" -H "Content-Type: application/json" \
  -d "{\"name\":\"crimeopus-cache-${DATACENTER,,}\",\"size\":$VOLUME_GB,\"dataCenterId\":\"$DATACENTER\"}" \
  --max-time 30)
VOL_ID=$(echo "$VOL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
[ -z "$VOL_ID" ] && { echo "✗ creazione volume fallita: $VOL_RESP"; exit 1; }
echo "  ✓ volume id: $VOL_ID"

# ── 3. aggiorna profilo AWS S3 locale ──────────────────────────
echo "▶ Aggiorno profilo AWS 'runpods3' (endpoint $S3_ENDPOINT)…"
mkdir -p "$HOME/.aws"
python3 - <<PYEOF
import os, configparser
cfg_path = os.path.expanduser("~/.aws/config")
cfg = configparser.ConfigParser()
cfg.read(cfg_path)
sec = "profile runpods3"
if sec not in cfg: cfg[sec] = {}
cfg[sec]["region"] = "$DATACENTER"
cfg[sec]["endpoint_url"] = "$S3_ENDPOINT"
cfg[sec]["output"] = "json"
with open(cfg_path, "w") as f: cfg.write(f)
print("  ✓ ~/.aws/config aggiornato")
PYEOF

# ── 4. attach volume all'endpoint ──────────────────────────────
echo "▶ Attach volume → endpoint $ENDPOINT_ID…"
curl -sS -X PATCH "https://rest.runpod.io/v1/endpoints/$ENDPOINT_ID" \
  -H "Authorization: Bearer $RP_KEY" -H "Content-Type: application/json" \
  -d "{\"networkVolumeId\":\"$VOL_ID\"}" --max-time 30 > /dev/null
echo "  ✓ attached"

# ── 5. refresh worker pool ────────────────────────────────────
echo "▶ Refresh worker (max 0 → 3)…"
curl -sS -X POST "https://api.runpod.ai/v2/$ENDPOINT_ID/purge-queue" \
  -H "Authorization: Bearer $RP_KEY" --max-time 15 > /dev/null
curl -sS -X PATCH "https://rest.runpod.io/v1/endpoints/$ENDPOINT_ID" \
  -H "Authorization: Bearer $RP_KEY" -H "Content-Type: application/json" \
  -d '{"workersMax":0}' --max-time 30 > /dev/null
sleep 20
curl -sS -X PATCH "https://rest.runpod.io/v1/endpoints/$ENDPOINT_ID" \
  -H "Authorization: Bearer $RP_KEY" -H "Content-Type: application/json" \
  -d '{"workersMax":3}' --max-time 30 > /dev/null
echo "  ✓ workers refreshed"

# ── 6. pre-warm (max 12 min) ──────────────────────────────────
echo "▶ Pre-warm: prima chiamata cold start (può durare 5-10 min)…"
JOB_ID=$(curl -sS -X POST "https://api.runpod.ai/v2/$ENDPOINT_ID/run" \
  -H "Authorization: Bearer $RP_KEY" -H "Content-Type: application/json" \
  -d '{"input":{"openai_route":"/chat/completions","openai_input":{"model":"crimeopus-runpod","messages":[{"role":"user","content":"prewarm"}],"max_tokens":5}}}' \
  --max-time 15 | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
echo "  job id: $JOB_ID"
for i in $(seq 1 24); do
  sleep 30
  STATUS=$(curl -sS "https://api.runpod.ai/v2/$ENDPOINT_ID/status/$JOB_ID" \
    -H "Authorization: Bearer $RP_KEY" --max-time 10 \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))")
  echo "    [+$((i*30))s] $STATUS"
  case "$STATUS" in
    COMPLETED) echo "  ✓ pre-warm OK"; break ;;
    FAILED|CANCELLED) echo "  ✗ pre-warm fallito"; exit 1 ;;
  esac
done

# ── 7. catalog: runpod primary di crimeopus-agentic ───────────
echo "▶ Aggiorno catalog gateway: runpod come primary di crimeopus-agentic…"
ssh_remote 'python3 - <<PYREMOTE
import json, sys
path = "/opt/crimeopus-api/catalog.json"
c = json.load(open(path))
c["crimeopus-agentic"]["providers"] = [
  {"provider":"runpod","model":"crimeopus-runpod"},
  {"provider":"together","model":"Qwen/Qwen3-235B-A22B-Instruct-2507-tput"},
  {"provider":"groq","model":"llama-3.3-70b-versatile"},
]
c["crimeopus-agentic"]["description"] = "Modello uncensored abliterated. Primary: Huihui-Qwen3.6-35B-A3B su RunPod (tool calling nativo). Failover: Qwen3-235B (Together) → Llama-3.3-70B (Groq)."
open(path, "w").write(json.dumps(c, indent=2, ensure_ascii=False))
print("  ✓ catalog updated")
PYREMOTE'
ssh_remote 'systemctl restart crimeopus-api && sleep 3 && systemctl is-active crimeopus-api'

# ── 8. rinomina nei 4 config user-globali ─────────────────────
echo "▶ Rinomino il modello user-side (rimette FullUncensored)…"
NEW_NAME="CrimeOpus AGENTIC FullUncensored — RunPod (Huihui-Qwen3.6-35B abliterated)"
for F in \
  "$HOME/.config/opencode/opencode.jsonc" \
  "$HOME/.opencode/opencode.jsonc" \
  "$HOME/.openworm/opencode.jsonc" \
  "$LOCALAPPDATA/openworm/opencode.jsonc" 2>/dev/null; do
  [ -f "$F" ] || continue
  sed -i "s|\"CrimeOpus AGENTIC[^\"]*\"|\"$NEW_NAME\"|" "$F"
  echo "  ✓ $F"
done

# ── 9. smoke test ────────────────────────────────────────────
echo "▶ Smoke test finale via gateway…"
curl -sS https://ai.crimecode.cc/v1/chat/completions \
  -H "Authorization: Bearer sk-test-crimeopus-2026" \
  -H "Content-Type: application/json" \
  -d '{"model":"crimeopus-agentic","messages":[{"role":"user","content":"di solo: ok"}],"max_tokens":5}' \
  --max-time 60 -w "\n  HTTP: %{http_code}  elapsed: %{time_total}s\n" | head -c 600

echo
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✓ Setup completo. Riavvia OpenCode Desktop.     ║"
echo "║  Il modello AGENTIC ora gira sul VERO Huihui     ║"
echo "║  abliterated su RunPod $DATACENTER.              ║"
echo "╚══════════════════════════════════════════════════╝"
