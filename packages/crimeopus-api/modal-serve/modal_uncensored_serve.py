"""
modal_uncensored_serve.py — endpoint OpenAI-compatible per Huihui-Qwen3.6-35B
                            abliterated, scale-to-zero, su Modal H100.

Usa il pattern `@modal.web_server`: vLLM gira col SUO entrypoint ufficiale
(`python -m vllm.entrypoints.openai.api_server`) sulla porta 8000 interna del
container, e Modal espone quella porta come URL pubblico HTTPS. È molto più
robusto che importare i moduli interni di vLLM (che cambiano API ogni release).

Costi:
  - Idle (>5 min): $0/h
  - Attivo H100 80GB: ~$1.95/h
  - $30 free Modal/mese reggono ~15h di GPU attiva

Deploy:
  modal deploy modal_uncensored_serve.py

Override:
  HF_MODEL=...    QUANTIZATION=fp4    GPU_TYPE=H100    MAX_MODEL_LEN=32768
"""
from __future__ import annotations

import os
import subprocess
import modal

# ── Configurazione ──────────────────────────────────────────────────
APP_NAME = "crimeopus-uncensored-serve"
# "Ferrari uncensored" finale: DavidAU's Qwen3.6-40B Heretic Deckard.
#
# Caratteristiche distintive:
#  - Dense 40B (no MoE) → più preciso del 35B-A3B su task complessi
#  - "Heretic" abliteration: tecnica multi-stage post-RLHF, refusal rate ~0%
#  - Distillato da Claude 4.6 Opus (chain-of-thought ereditato)
#  - "Thinking" native (reasoning chain interno automatico)
#  - "Deckard" style: high creativity + reasoning balance
#
# Footprint: BF16 ~80 GB pesi + ~15 GB KV cache + ~10 GB CUDA graphs ≈ 105 GB
# → NON entra in H100 80GB (provato → OOM 372 MiB short).
# H200 141GB ci sta largo, no quantization runtime → modello BF16 nativo
# (qualità massima). Costo: $3.95/h H200, idle $0. Free tier $30 ≈ 7-8h GPU.
HF_MODEL = os.environ.get(
    "HF_MODEL",
    "DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking",
)
# Empty = BF16 nativo (auto-detect dal config). Niente quant lossy.
QUANTIZATION = os.environ.get("QUANTIZATION", "")
SERVED_MODEL_NAME = os.environ.get("SERVED_MODEL_NAME", "crimeopus-agentic")
GPU_TYPE = os.environ.get("GPU_TYPE", "H200")
MAX_MODEL_LEN = int(os.environ.get("MAX_MODEL_LEN", "32768"))
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT", "300"))
GPU_MEM_UTIL = float(os.environ.get("GPU_MEM_UTIL", "0.92"))

VLLM_PORT = 8000

# ── App + image ────────────────────────────────────────────────────
app = modal.App(APP_NAME)

vllm_image = (
    # Image ufficiale vLLM con vLLM + torch + cuda + transformers già allineati
    # Tag "latest" prende l'ultima stable, che supporta qwen3_next/qwen3_5_moe.
    modal.Image.from_registry("vllm/vllm-openai:latest", add_python="3.12")
    .apt_install("git")
    # transformers da git main: garantisce qwen3_5_moe arch riconosciuta.
    # more_itertools serve perché transformers 5.x dev ha cambiato setuptools
    # vendor in modo da richiederla esplicitamente.
    .pip_install(
        "git+https://github.com/huggingface/transformers.git",
        "more_itertools",
        "hf-transfer>=0.1.8",
    )
    .env({
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
        "VLLM_DO_NOT_TRACK": "1",
    })
    .entrypoint([])  # disable the vllm/vllm-openai default entrypoint, we run our own
)

hf_cache = modal.Volume.from_name("crimeopus-uncensored-cache", create_if_missing=True)
HF_CACHE_PATH = "/root/.cache/huggingface"

hf_secret = modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"])


# ── Serve class ────────────────────────────────────────────────────
@app.cls(
    image=vllm_image,
    gpu=GPU_TYPE,
    secrets=[hf_secret],
    volumes={HF_CACHE_PATH: hf_cache},
    timeout=60 * 60,
    scaledown_window=IDLE_TIMEOUT,
    min_containers=0,
    max_containers=2,
)
@modal.concurrent(max_inputs=20)
class UncensoredVLLM:
    @modal.web_server(port=VLLM_PORT, startup_timeout=60 * 30)
    def serve(self):
        """Spawn vLLM's official OpenAI-compatible API server on VLLM_PORT.
        Modal forwards the port as an HTTPS endpoint and gives back a *.modal.run URL."""
        # vLLM CLI flag set per la versione 0.12+ (image vllm/vllm-openai:latest):
        #  - --disable-log-requests è stato rimosso, lo è di default ora
        #  - --enable-prefix-caching è on by default
        cmd = [
            "python", "-m", "vllm.entrypoints.openai.api_server",
            "--host", "0.0.0.0",
            "--port", str(VLLM_PORT),
            "--model", HF_MODEL,
            "--served-model-name", SERVED_MODEL_NAME,
            "--max-model-len", str(MAX_MODEL_LEN),
            "--gpu-memory-utilization", str(GPU_MEM_UTIL),
            "--dtype", "auto",
            "--trust-remote-code",
            # Tool calling Qwen3-MoE (non hermes — quello era per Qwen2)
            "--enable-auto-tool-choice",
            "--tool-call-parser", "qwen3_xml",
            # Reasoning parser: Qwen3.x emette <think>...</think> chain-of-thought
            # nativo. Senza questo, il <think> finisce nel content visibile.
            "--reasoning-parser", "qwen3",
            # Modelli ibridi (Mamba + attention) hanno cache blocks limitati.
            # max_num_seqs 256 entra largo nei Mamba cache blocks tipici.
            "--max-num-seqs", "256",
            # Riduce conflitti tra chunked prefill e mamba state caching.
            "--no-enable-chunked-prefill",
            # Skip torch.compile + cudagraph capture (richiede 15+ min su
            # modelli Mamba ibridi → supera startup_timeout). Inference 30%
            # più lenta ma boot in ~2 min invece di 15+.
            "--enforce-eager",
        ]
        if QUANTIZATION:
            cmd.extend(["--quantization", QUANTIZATION])

        print("▶ Starting vLLM:", " ".join(cmd))
        # Nota: subprocess.Popen senza wait — il processo deve restare in vita
        # mentre Modal forwarda la porta.
        subprocess.Popen(cmd)
