# RunPod Serverless — modelli CrimeOpus custom su GPU cloud scale-to-zero

Container vLLM che serve un tuo modello custom (GGUF, AWQ, GPTQ, safetensors)
da Hugging Face come endpoint OpenAI-compatible. Su RunPod Serverless
**paghi solo i secondi attivi** — quando nessuno chiama l'endpoint, scale-to-0.

## Costi tipici

| GPU | $/h attivo | Modello tipico | Cold start |
|---|---|---|---|
| RTX 4090 24GB | ~$0.50 | 13B-30B Q4 | ~30s |
| RTX A6000 48GB | ~$0.80 | 30B-70B Q4 | ~45s |
| A100 80GB | ~$1.40 | 70B FP8 / 405B Q4 | ~60s |
| H100 80GB | ~$2.99 | High-throughput everything | ~45s |

**Esempio pratico**: 100 utenti × 50 req/giorno × 2s/req = ~3h GPU attiva/giorno
→ ~$45/mese su RTX 4090 (vs $400 di un VPS GPU 24/7).

## Setup

### 1. Build & push l'image

```bash
cd packages/crimeopus-api/runpod-serverless

# Build (richiede Docker + ~6 GB free)
docker build -t ghcr.io/your-org/crimeopus-vllm:latest .

# Login GitHub Container Registry (o Docker Hub)
echo $GHCR_TOKEN | docker login ghcr.io -u your-username --password-stdin

# Push
docker push ghcr.io/your-org/crimeopus-vllm:latest
```

### 2. Crea il Serverless endpoint

1. Vai su https://www.runpod.io/console/serverless → **New Endpoint**
2. **Custom container**:
   - Image: `ghcr.io/your-org/crimeopus-vllm:latest`
   - Container Disk: 50 GB (più grande del modello)
   - Start Command: vuoto (Dockerfile gestisce)
3. **GPU**: scegli in base al modello
4. **Workers**:
   - Min: **0** (scale-to-zero, paghi solo se attivo)
   - Max: 4-10 (limite parallelismo simultaneo)
   - Idle Timeout: 60s
5. **Network volume** (raccomandato per modelli > 5 GB):
   - Crea volume RunPod 100 GB ($0.07/GB/mese = $7/mese)
   - Mount: `/runpod-volume` (il Dockerfile lo usa per cache HF)
   - Risparmi 5-10 minuti di re-download a ogni cold-start su nuovo worker
6. **Env vars**:
   ```
   MODEL_REPO=yourorg/CrimeOpus-4.7-GGUF
   MODEL_FILE=CrimeOpus4.7.Q4_K_M.gguf
   HF_TOKEN=hf_xxx        # se repo privato
   MAX_MODEL_LEN=8192
   DTYPE=auto
   GPU_MEMORY=0.92
   RUNPOD_SERVERLESS=1    # IMPORTANTE
   ```
7. **Save** → ottieni:
   - Endpoint ID (es. `abc123def`)
   - URL OpenAI-compatible: `https://api.runpod.ai/v2/abc123def/openai/v1`
   - API key: dal pannello https://www.runpod.io/console/user/settings

### 3. Configura il gateway

Edita `.env` del CrimeOpus API gateway:

```bash
UPSTREAM_PROVIDERS='[
  {
    "id": "runpod-crimeopus",
    "kind": "openai",
    "url": "https://api.runpod.ai/v2/abc123def/openai/v1",
    "apiKey": "rpa_xxx_yourrunpodapikey",
    "weight": 1,
    "maxInflight": 4
  },
  {
    "id": "together-fallback",
    "kind": "openai",
    "url": "https://api.together.xyz/v1",
    "apiKey": "tgs_xxx",
    "weight": 0,
    "maxInflight": 5
  }
]'
```

`catalog.json`:
```json
{
  "crimeopus-default": {
    "display": "CrimeOpus 4.7",
    "providers": [
      { "provider": "runpod-crimeopus",   "model": "crimeopus-default" },
      { "provider": "together-fallback",  "model": "Qwen/Qwen2.5-72B-Instruct-Turbo" }
    ]
  }
}
```

Il gateway prova **prima RunPod (tuo modello custom)**; se è giù o saturo,
fallback su Together (modello equivalent open). I clienti vedono sempre
`crimeopus-default` come nome — non sanno mai quale backend ha risposto.

### 4. Test

```bash
# Test diretto RunPod (bypass gateway)
curl -H "Authorization: Bearer rpa_xxx" \
     -H "Content-Type: application/json" \
     -d '{"model":"crimeopus-default","messages":[{"role":"user","content":"ciao"}]}' \
     https://api.runpod.ai/v2/abc123def/openai/v1/chat/completions

# Test via gateway
curl -H "Authorization: Bearer sk-yourtest" \
     -H "Content-Type: application/json" \
     -d '{"model":"crimeopus-default","messages":[{"role":"user","content":"ciao"}]}' \
     https://api.tuodominio.dev/v1/chat/completions
```

## Test locale (senza RunPod)

Se hai un PC con GPU NVIDIA e vuoi testare il container prima di pushare:

```bash
docker build -t crimeopus-vllm-local .
docker run --gpus all \
  -e MODEL_REPO=Qwen/Qwen2.5-1.5B-Instruct \
  -e MAX_MODEL_LEN=4096 \
  -p 8000:8000 \
  crimeopus-vllm-local

# In un altro terminale
curl -d '{"model":"crimeopus-default","messages":[{"role":"user","content":"ciao"}]}' \
     -H "Content-Type: application/json" \
     http://localhost:8000/v1/chat/completions
```

## Troubleshooting

| Sintomo | Soluzione |
|---|---|
| Cold start molto lento (> 5 min) | Usa Network Volume per cache HF, scegli GPU con boot più veloce |
| OOM su modello 70B | Passa a A100 80GB o quantizzazione AWQ/GPTQ |
| `flash_attn` errore | Aggiungi `--enforce-eager` agli args vLLM nel start.sh |
| GGUF non riconosciuto | vLLM ≥ 0.6 supporta GGUF; verifica versione nel Dockerfile |
| 401 da RunPod | API key sbagliata o endpoint id sbagliato — controlla URL |
| Worker idle non scala a 0 | Idle Timeout impostato troppo alto; metti 60s |

## Modello di costo dettagliato

Esempio: 1000 richieste/mese, media 1500 token/richiesta, GPU RTX 4090

- 1000 × 1.5s inferenza = 25 min totali
- + cold-start: dipende dal pattern di traffico
  - Traffico costante (1 req/min) → 0 cold-start dopo il primo
  - Traffico burst (notte spento, giorno attivo) → 4-8 cold-start/giorno × 30s = ~3h aggiuntive
- Totale: ~3-4h/mese di GPU attiva
- Costo: 4h × $0.50 = **$2/mese di compute**
- + Network Volume: $7/mese
- **Totale: ~$9/mese** per servire 1000 richieste/mese del tuo modello custom

Per confronto: 1000 richieste su Together Llama 3.3 70B (~1.5M token) = $0.90.
**Cloud-hosted open è più economico finché il volume è basso**;
**RunPod custom è migliore quando hai traffico costante e/o volume alto E
vuoi un modello tuo specifico**.
