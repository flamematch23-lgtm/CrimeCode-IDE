# Modal Serve — Huihui-Qwen3.6-35B abliterated come endpoint OpenAI

Alternativa a RunPod per servire il modello custom uncensored gratis (entro
il free credit Modal di $30, rinnovabile mensilmente). Scale-to-zero: paghi
solo quando una request è in corso, idle = $0/h.

## Costi reali

| Stato | Costo |
|---|---|
| Container idle (>5 min senza request) | **$0** |
| Container caldo, una request `crimeopus-agentic` | ~$1.95/h H100 → **~$0.001/secondo** |
| Una chat tipica (5 msg × 10s ciascuno) | **~$0.03** |
| 30 chat al giorno | **~$0.50/giorno → ~$15/mese** |

I $30 di credit free mensile Modal coprono **comodamente** l'uso normale.

## Prereq

```bash
pip install modal
modal token new                                        # 1 sola volta, browser SSO
modal secret create huggingface HF_TOKEN=hf_xxxxxxxx   # crea il secret HF
```

Se non hai un HF_TOKEN: https://huggingface.co/settings/tokens → "Create new token" → Read access basta.

## Deploy

```bash
cd packages/crimeopus-api/modal-serve
modal deploy modal_uncensored_serve.py
```

Output atteso:
```
✓ App crimeopus-uncensored-serve deployed
✓ Created web endpoint => https://<your-username>--crimeopus-uncensored-serve-uncensoredvllm-openai-app.modal.run
```

Copia quell'URL.

## Registra nel gateway

```bash
bash register-modal-in-gateway.sh https://<your-username>--crimeopus-uncensored-serve-uncensoredvllm-openai-app.modal.run
```

Lo script fa tutto:
1. Aggiunge `modal-uncensored` al `UPSTREAM_PROVIDERS` nel `/etc/crimeopus-api.env`
2. Riordina catalog di `crimeopus-agentic` con Modal come primary
3. Restart gateway
4. Smoke test
5. Rinomina nei tuoi config user-globali in `"CrimeOpus AGENTIC FullUncensored — Modal (Huihui-…abliterated)"`

## Cold start

Primo uso dopo deploy: **2-3 minuti** (download 17 GB del modello da HF al
volume Modal). I successivi cold start (post idle): **~30-60 secondi**
perché il modello è già nella cache del volume.

Mitigazione cold start (opzionale, costa più):
- `min_containers=1` in `modal_uncensored_serve.py` → 1 container sempre caldo
  → ~$1.95/h × 24h = $46/mese (sfora il free tier!)
- Lascia `min_containers=0` (default) e accetta i 30-60s di delay quando
  rientri da idle.

## Override comuni

```bash
# Modello diverso (es. la versione FP4 su sakamakismile, se disponibile)
HF_MODEL=sakamakismile/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-NVFP4 \
  modal deploy modal_uncensored_serve.py

# GPU più economica (A100 80GB invece di H100)
GPU_TYPE=A100-80GB modal deploy modal_uncensored_serve.py

# Idle più aggressivo (90s invece di 300s) per risparmiare ancora
IDLE_TIMEOUT=90 modal deploy modal_uncensored_serve.py

# Context window ridotto se servono meno token
MAX_MODEL_LEN=8192 modal deploy modal_uncensored_serve.py
```

## Monitoraggio

```bash
modal app logs crimeopus-uncensored-serve     # log live
modal app stats crimeopus-uncensored-serve    # uptime, costs, request count
modal volume ls crimeopus-uncensored-cache    # quanto pesa la cache HF
```

## Stop / undeploy

```bash
# spegni temporaneamente (zero idle, riparte alla prima request)
# automatico — è già scale-to-zero

# undeploy completo (rimuove l'endpoint, libera risorse)
modal app stop crimeopus-uncensored-serve

# elimina anche la cache HF (~17GB persistenti)
modal volume rm crimeopus-uncensored-cache
```

## Troubleshooting

| Sintomo | Soluzione |
|---|---|
| `503 cold starting` per >5 min | Verifica `modal app logs` — di solito è download del modello al primo boot, attendi |
| `OOM during model loading` | Scendi a `GPU_TYPE=H100` (è già il default), oppure quantizza il modello in AWQ/GPTQ prima del deploy |
| `tool_call_parser=hermes not supported` | vLLM 0.6.4+ supporta hermes; verifica versione nel `pip_install` dell'image |
| `modal: command not found` | `pip install modal` o `pipx install modal` |
| Saldo Modal a 0 | https://modal.com/settings/billing → top-up o aspetti il rinnovo $30 mensile del free tier |

## Differenze vs RunPod

| Item | Modal scale-to-zero | RunPod serverless |
|---|---|---|
| Free tier | **$30/mese rinnovabile** | nessun free, serve top-up $5+ |
| GPU | H100/A100/L4 | H100/A100/4090/etc |
| Cold start (cached) | 30-60s | 30-60s |
| Cold start (no cache) | 2-3 min | 2-3 min |
| Scale-to-zero | sì, default | sì, default |
| Datacenter constraint | no, on-demand | sì se volume attached |
| Setup complexity | 1 file Python + 1 deploy | dashboard UI multi-step |
| Pricing transparency | per secondo, fattura unificata | per secondo, separato per worker/storage |
