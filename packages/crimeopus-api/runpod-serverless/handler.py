"""
RunPod serverless handler che fa da bridge tra il dispatcher RunPod e
il vLLM OpenAI server in background.

RunPod ti chiama con un job:
    { "input": { "openai_route": "/chat/completions",
                 "openai_input": <body OpenAI std> } }

Noi:
  1. Mappiamo openai_route → /v1/<route> sul vLLM locale
  2. Forwardiamo il body inalterato
  3. Restituiamo la response (streaming via runpod.serverless.utils.rp_stream
     se il client OpenAI ha chiesto stream=True)

Questo handler è agnostico al modello: tutto ciò che vLLM serve è
disponibile via OpenAI API.
"""
import os
import json
import logging
import asyncio
import httpx
import runpod
from runpod.serverless.utils import rp_validator

VLLM_BASE = f"http://127.0.0.1:{os.environ.get('VLLM_PORT', '8000')}"
TIMEOUT = httpx.Timeout(300.0, connect=10.0)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("handler")


async def forward(route: str, payload: dict, want_stream: bool):
    """Forward a un endpoint OpenAI sul vLLM locale.

    Se want_stream=True usa SSE pass-through emettendo chunks via yield.
    Altrimenti restituisce il body json completo.
    """
    url = f"{VLLM_BASE}/v1{route}"
    log.info(f"→ {route} stream={want_stream}")
    headers = {"Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        if want_stream:
            async with client.stream("POST", url, json=payload, headers=headers) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    yield line + "\n"
        else:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            yield r.json()


async def handler(job):
    """Entry-point RunPod.

    Compatibilità con due forme di input:
      A) { "openai_route": "/chat/completions", "openai_input": {...} }
         (forma esplicita raccomandata)
      B) Body OpenAI diretto, route inferita da presenza di 'messages'
         (ergonomic shortcut)
    """
    job_input = job.get("input", {})
    route = job_input.get("openai_route")
    payload = job_input.get("openai_input")

    if not route or not payload:
        # Shortcut: input è il body OpenAI diretto
        if "messages" in job_input:
            route = "/chat/completions"
            payload = job_input
        elif "input" in job_input and "model" in job_input:
            route = "/embeddings"
            payload = job_input
        else:
            return {"error": "missing openai_route and openai_input. See README."}

    want_stream = bool(payload.get("stream", False))

    try:
        if want_stream:
            chunks = []
            async for chunk in forward(route, payload, want_stream=True):
                chunks.append(chunk)
                # RunPod streaming: yield to the dispatcher
                yield chunk
            # Final yield optional
        else:
            async for body in forward(route, payload, want_stream=False):
                yield body
    except httpx.HTTPStatusError as e:
        body = await e.response.aread()
        err = body.decode("utf-8", errors="ignore")[:500]
        log.error(f"vllm {route} → {e.response.status_code}: {err}")
        yield {"error": {"message": f"vllm error {e.response.status_code}: {err}", "type": "upstream"}}
    except Exception as e:
        log.exception("handler crashed")
        yield {"error": {"message": str(e), "type": "internal"}}


# Health: ensure vLLM is ready before accepting jobs.
async def health_check():
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.get(f"{VLLM_BASE}/v1/models")
            return r.status_code == 200
        except Exception:
            return False


if __name__ == "__main__":
    log.info(f"Starting RunPod serverless handler — vLLM at {VLLM_BASE}")
    runpod.serverless.start({
        "handler": handler,
        "return_aggregate_stream": True,  # stream chunks to client as they arrive
    })
