"""
modal_uncensored_serve.py — endpoint OpenAI-compatible per Huihui-Qwen3.6-35B
                            abliterated, scale-to-zero, su Modal H100.

Architettura:
  Client → ai.crimecode.cc (gateway Hetzner) → questo Modal endpoint → vLLM → tu

Costi ($30 free credit Modal):
  - Idle: $0/h (container scale to zero dopo IDLE_TIMEOUT secondi)
  - Attivo: ~$1.95/h H100 80GB
  - Cold start: ~2-3 min al primo boot dopo idle (download del modello da HF
    se prima volta, poi ~30-60s leggendo dalla cache nel volume Modal)
  - Esempio: 30 chat al giorno × ~30s di GPU active ≈ 0.25h/giorno × $1.95 ≈
    $0.50/giorno → $30 free reggono ~60 giorni di uso normale

Lancia:
  modal token new                            # 1 sola volta
  modal secret create huggingface HF_TOKEN=hf_xxx
  modal deploy modal_uncensored_serve.py
  # output: ✓ Created web endpoint => https://<user>--crimeopus-uncensored-serve.modal.run

Poi mi dai quell'URL e lo aggiungo al catalog del gateway crimeopus-api come
provider primary di crimeopus-agentic.

Override:
  modal deploy modal_uncensored_serve.py \\
    --env HF_MODEL=huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated \\
    --env GPU_TYPE=A100-80GB \\
    --env IDLE_TIMEOUT=180
"""
from __future__ import annotations

import os
import modal

# ── 1. Configurazione (override-abile via env al deploy) ──────────────
APP_NAME = "crimeopus-uncensored-serve"
HF_MODEL = os.environ.get("HF_MODEL", "huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated")
SERVED_MODEL_NAME = os.environ.get("SERVED_MODEL_NAME", "crimeopus-agentic")
GPU_TYPE = os.environ.get("GPU_TYPE", "H100")
MAX_MODEL_LEN = int(os.environ.get("MAX_MODEL_LEN", "32768"))
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT", "300"))  # 5 min idle = scale-to-zero
GPU_MEM_UTIL = float(os.environ.get("GPU_MEM_UTIL", "0.92"))

VLLM_PORT = 8000

# ── 2. App + image ────────────────────────────────────────────────────
app = modal.App(APP_NAME)

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "build-essential")
    .pip_install(
        "torch==2.5.1",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "vllm==0.6.4.post1",
        "fastapi==0.115.5",
        "uvicorn==0.32.1",
        "huggingface_hub==0.26.2",
        "hf-transfer==0.1.8",
    )
    .env({
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
        "VLLM_DO_NOT_TRACK": "1",
    })
)

hf_cache = modal.Volume.from_name("crimeopus-uncensored-cache", create_if_missing=True)
HF_CACHE_PATH = "/root/.cache/huggingface"

hf_secret = modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"])


# ── 3. The serve class ───────────────────────────────────────────────
@app.cls(
    image=vllm_image,
    gpu=GPU_TYPE,
    secrets=[hf_secret],
    volumes={HF_CACHE_PATH: hf_cache},
    timeout=60 * 60,                       # max 1 ora per request (più che generoso)
    container_idle_timeout=IDLE_TIMEOUT,   # scale-to-zero dopo IDLE_TIMEOUT s
    allow_concurrent_inputs=20,            # vLLM batching: serve N request in parallelo
    min_containers=0,                      # scale-to-zero attivo
    max_containers=2,                      # cap costi: max 2 container H100 contemporanei
)
class UncensoredVLLM:
    @modal.enter()
    def boot(self):
        """Carica vLLM una volta per container, riusa per tutte le request."""
        from vllm import AsyncEngineArgs, AsyncLLMEngine
        from vllm.entrypoints.openai.serving_chat import OpenAIServingChat
        from vllm.entrypoints.openai.serving_completion import OpenAIServingCompletion
        from vllm.entrypoints.openai.protocol import ModelCard, ModelList

        print(f"▶ Loading {HF_MODEL} on {GPU_TYPE}…")
        args = AsyncEngineArgs(
            model=HF_MODEL,
            tokenizer=HF_MODEL,
            max_model_len=MAX_MODEL_LEN,
            gpu_memory_utilization=GPU_MEM_UTIL,
            dtype="auto",
            trust_remote_code=True,
            enable_prefix_caching=True,    # speed: riusa KV cache su prompt ripetuti
            enable_chunked_prefill=False,
            served_model_name=[SERVED_MODEL_NAME],
            disable_log_stats=False,
            disable_log_requests=True,
            # Tool calling (Hermes parser, come template RunPod che funzionava)
            enable_auto_tool_choice=True,
            tool_call_parser="hermes",
        )
        self.engine = AsyncLLMEngine.from_engine_args(args)

        # OpenAI-compatible serving handlers
        models = ModelList(data=[ModelCard(id=SERVED_MODEL_NAME, root=HF_MODEL, permission=[])])
        self.chat = OpenAIServingChat(
            self.engine,
            model_config=None,   # vLLM 0.6 lo deriva dall'engine
            served_model_names=[SERVED_MODEL_NAME],
            response_role="assistant",
            lora_modules=None,
            prompt_adapters=None,
            request_logger=None,
            chat_template=None,
        )
        self.completion = OpenAIServingCompletion(
            self.engine,
            model_config=None,
            served_model_names=[SERVED_MODEL_NAME],
            lora_modules=None,
            prompt_adapters=None,
            request_logger=None,
        )
        self.models_card = models
        # Persist HF cache so future cold starts skip re-download
        hf_cache.commit()
        print(f"✓ vLLM ready, served model name: {SERVED_MODEL_NAME}")

    # ── Web endpoints (OpenAI-compatible) ────────────────────────────
    @modal.asgi_app()
    def openai_app(self):
        from fastapi import FastAPI, Request
        from fastapi.responses import StreamingResponse, JSONResponse
        from vllm.entrypoints.openai.protocol import (
            ChatCompletionRequest,
            CompletionRequest,
            ErrorResponse,
        )

        api = FastAPI(title="CrimeOpus Uncensored — vLLM on Modal")

        @api.get("/health")
        async def health():
            return {"ok": True, "model": SERVED_MODEL_NAME}

        @api.get("/v1/models")
        async def list_models():
            return self.models_card

        @api.post("/v1/chat/completions")
        async def chat_completions(req: ChatCompletionRequest, raw: Request):
            generator = await self.chat.create_chat_completion(req, raw)
            if isinstance(generator, ErrorResponse):
                return JSONResponse(content=generator.model_dump(), status_code=generator.code)
            if req.stream:
                return StreamingResponse(content=generator, media_type="text/event-stream")
            return JSONResponse(content=generator.model_dump())

        @api.post("/v1/completions")
        async def completions(req: CompletionRequest, raw: Request):
            generator = await self.completion.create_completion(req, raw)
            if isinstance(generator, ErrorResponse):
                return JSONResponse(content=generator.model_dump(), status_code=generator.code)
            if req.stream:
                return StreamingResponse(content=generator, media_type="text/event-stream")
            return JSONResponse(content=generator.model_dump())

        return api
