# RunPod Serverless container che serve un modello CrimeOpus custom
# tramite vLLM + endpoint OpenAI-compatible.
#
# Build:
#   cd packages/crimeopus-api/runpod-serverless
#   docker build -t ghcr.io/your-org/crimeopus-vllm:latest .
#   docker push ghcr.io/your-org/crimeopus-vllm:latest
#
# Quindi su RunPod:
#   1. Vai su https://www.runpod.io/console/serverless
#   2. New Endpoint → Custom container
#   3. Container Image: ghcr.io/your-org/crimeopus-vllm:latest
#   4. GPU: RTX 4090 (24 GB) per modelli ≤ 30B, A100 80GB per ≥ 70B
#   5. Min Workers: 0  (scale-to-zero — paghi solo quando attivi)
#   6. Max Workers: N (limite parallelismo)
#   7. Idle Timeout: 60s (worker spegne se idle 1 min)
#   8. Container Start Command: lascia vuoto (Dockerfile ENTRYPOINT)
#   9. Env vars:
#        MODEL_REPO=yourorg/CrimeOpus-4.7-GGUF
#        MODEL_FILE=CrimeOpus4.7.Q4_K_M.gguf  (o senza per safetensors)
#        HF_TOKEN=hf_xxx (per repo privati)
#        MAX_MODEL_LEN=8192
#        DTYPE=auto
#  10. Save → endpoint id (es. abc123). URL OpenAI:
#        https://api.runpod.ai/v2/abc123/openai/v1
#
# Nel tuo gateway crimeopus-api:
#   UPSTREAM_PROVIDERS=[{"id":"runpod","kind":"openai",
#                        "url":"https://api.runpod.ai/v2/abc123/openai/v1",
#                        "apiKey":"<RUNPOD_API_KEY>","weight":1,"maxInflight":4}]

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Python + tooling minimo
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3-pip git wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# vLLM ha richiesto torch già installato — usiamo l'index Nvidia
RUN pip3 install --no-cache-dir \
    torch==2.4.0 --index-url https://download.pytorch.org/whl/cu124

# vLLM + RunPod SDK + HF
RUN pip3 install --no-cache-dir \
    vllm==0.6.3 \
    runpod \
    huggingface_hub \
    fastapi==0.115.0 \
    uvicorn==0.30.6

# Cache HF in volume montato
ENV HF_HOME=/runpod-volume/huggingface \
    TRANSFORMERS_CACHE=/runpod-volume/huggingface \
    VLLM_DO_NOT_TRACK=1

WORKDIR /app
COPY handler.py /app/handler.py
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Espone la porta vLLM standard (8000) + endpoint RunPod
ENV VLLM_PORT=8000
EXPOSE 8000

ENTRYPOINT ["/app/start.sh"]
