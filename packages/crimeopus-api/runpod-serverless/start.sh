#!/usr/bin/env bash
# Entry-point del container RunPod.
#
# Modalità:
#   1. RUNPOD_SERVERLESS=1 (default su RunPod) → handler.py
#   2. Altrimenti → vLLM standalone + reverse proxy su /v1/* (utile per
#      test locale con Docker Desktop / GPU, fuori da RunPod).
set -euo pipefail

MODEL_REPO="${MODEL_REPO:-}"
MODEL_FILE="${MODEL_FILE:-}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
DTYPE="${DTYPE:-auto}"
GPU_MEMORY="${GPU_MEMORY:-0.92}"

if [[ -z "$MODEL_REPO" ]]; then
  echo "ERROR: env MODEL_REPO non impostato"
  echo "Esempio: export MODEL_REPO=yourorg/CrimeOpus-4.7-GGUF"
  exit 1
fi

# Costruisci args vLLM dinamicamente
VLLM_ARGS=(
  --model "$MODEL_REPO"
  --max-model-len "$MAX_MODEL_LEN"
  --dtype "$DTYPE"
  --gpu-memory-utilization "$GPU_MEMORY"
  --port "${VLLM_PORT:-8000}"
  --host 0.0.0.0
  --disable-log-requests
  --served-model-name crimeopus-default
)

# Modello GGUF? vLLM supporta GGUF dal v0.6
if [[ -n "$MODEL_FILE" ]]; then
  VLLM_ARGS+=(--quantization gguf)
fi

# HuggingFace token per repo privati
if [[ -n "${HF_TOKEN:-}" ]]; then
  export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"
fi

echo "▶ Starting vLLM with: ${VLLM_ARGS[*]}"

if [[ "${RUNPOD_SERVERLESS:-0}" == "1" ]]; then
  # Avvia vLLM in background, poi handler RunPod
  python3 -m vllm.entrypoints.openai.api_server "${VLLM_ARGS[@]}" &
  VLLM_PID=$!
  trap "kill $VLLM_PID 2>/dev/null || true" EXIT
  # Attendi vLLM ready
  for i in {1..120}; do
    if curl -sf http://127.0.0.1:${VLLM_PORT:-8000}/v1/models >/dev/null 2>&1; then
      echo "✓ vLLM ready"
      break
    fi
    sleep 2
  done
  exec python3 /app/handler.py
else
  # Standalone (no RunPod): solo vLLM in foreground
  exec python3 -m vllm.entrypoints.openai.api_server "${VLLM_ARGS[@]}"
fi
