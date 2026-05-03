"""
modal_training.py — QLoRA training di CrimeOpus 4.7-uncensored-v2 su Modal.

Stack:
  • Modal H100 80GB (~$1.95/h, $30 free al signup → 15h disponibili)
  • Unsloth (riduce VRAM 70%, raddoppia speed)
  • QLoRA 4-bit (entra in 24GB ma usiamo H100 per velocità)
  • PEFT/TRL per il training loop
  • Auto-push del LoRA adapter su HuggingFace al termine

Lancia:
  modal token new                    # 1 sola volta
  export HF_TOKEN=hf_xxxx            # token con write access al tuo account
  modal run modal_training.py

Override via CLI o env:
  modal run modal_training.py --epochs 3 --max-seq 4096
  HF_REPO=JollyFraud/crimeopus-v2-lora modal run modal_training.py
  WANDB_API_KEY=... per logging (opzionale)

Dopo il training:
  bash merge_lora.sh    # merge sul VPS Hetzner (CPU + 80GB RAM)
  bash quantize_gguf.sh # GGUF per il tuo PC RTX 3080 Ti
"""

import os
import modal

# ── 1. Modal app + image ───────────────────────────────────────────
APP_NAME = "crimeopus-training"
app = modal.App(APP_NAME)

CUDA_VERSION = "12.4.1"
FLAVOR = "devel"
OS = "ubuntu22.04"
TAG = f"{CUDA_VERSION}-{FLAVOR}-{OS}"

# Pin versions known to work together. Rebuild the image if you bump any of
# these — Unsloth releases break ~weekly so pin tightly.
training_image = (
    modal.Image.from_registry(f"nvidia/cuda:{TAG}", add_python="3.11")
    .apt_install("git", "build-essential")
    # Torch first, with the CUDA index URL — Unsloth refuses to install
    # against the CPU-only torch wheel.
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "unsloth[cu124-torch240] @ git+https://github.com/unslothai/unsloth.git@2026.4.0",
        "transformers==4.46.3",
        "peft==0.13.2",
        "trl==0.12.1",
        "datasets==3.1.0",
        "accelerate==1.1.1",
        "bitsandbytes==0.44.1",
        "huggingface-hub==0.26.2",
        "wandb==0.18.7",
        "sentencepiece==0.2.0",
        "protobuf==5.28.3",
        "tqdm",
    )
    # Set HF cache to a Modal Volume so re-runs skip re-download (~17 GB).
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

# Persistent volume for the HF cache (model weights) — survives across runs.
hf_cache = modal.Volume.from_name("crimeopus-hf-cache", create_if_missing=True)
HF_CACHE_PATH = "/root/.cache/huggingface"

# Persistent volume for the trained adapter checkpoints.
adapter_volume = modal.Volume.from_name("crimeopus-adapters", create_if_missing=True)
ADAPTER_PATH = "/adapters"

# ── 2. Secrets — set with `modal secret create` ────────────────────
hf_secret = modal.Secret.from_name(
    "huggingface", required_keys=["HF_TOKEN"]
)
# Optional: only needed if you want training charts on wandb.ai
wandb_secret = modal.Secret.from_name(
    "wandb", required_keys=["WANDB_API_KEY"]
)


# ── 3. The training function ───────────────────────────────────────
@app.function(
    image=training_image,
    gpu="H100",  # alternatives: "A100-80GB" (cheaper but slower)
    timeout=60 * 60 * 8,  # 8h hard cap, real run ~3-5h
    secrets=[hf_secret, wandb_secret],
    volumes={HF_CACHE_PATH: hf_cache, ADAPTER_PATH: adapter_volume},
)
def train(
    base_model: str = "huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated",
    dataset: str = "JollyFraud/crimeopus-distill-v2",
    hf_repo: str = "JollyFraud/crimeopus-v2-lora",
    max_seq_length: int = 8192,
    num_train_epochs: int = 3,
    per_device_train_batch_size: int = 1,
    gradient_accumulation_steps: int = 16,
    learning_rate: float = 2e-4,
    lora_r: int = 32,
    lora_alpha: int = 64,
    save_steps: int = 50,
    seed: int = 3407,
):
    """Run the QLoRA fine-tuning. Runs entirely on the Modal worker."""
    import torch
    from datasets import load_dataset
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import get_chat_template
    from trl import SFTTrainer, SFTConfig

    # ── Load model in 4-bit + Unsloth optimizations ──────────────
    print(f"▶ Loading base model: {base_model}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=base_model,
        max_seq_length=max_seq_length,
        dtype=torch.bfloat16,
        load_in_4bit=True,  # QLoRA: weights in NF4, gradients in bf16
        token=os.environ["HF_TOKEN"],
        cache_dir=HF_CACHE_PATH,
    )

    # Qwen3 chat template
    tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

    # ── LoRA adapter on top of the frozen 4-bit base ─────────────
    model = FastLanguageModel.get_peft_model(
        model,
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=0.05,
        bias="none",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        use_gradient_checkpointing="unsloth",  # 30% extra VRAM saving
        random_state=seed,
        use_rslora=False,
        loftq_config=None,
    )

    # ── Dataset ──────────────────────────────────────────────────
    print(f"▶ Loading dataset: {dataset}")
    ds = load_dataset(dataset, split="train", token=os.environ["HF_TOKEN"])
    print(f"  → {len(ds)} esempi")

    def format_example(ex):
        # The dataset is expected to have either:
        #   {"messages":[{"role":..., "content":...}, ...]} (preferred)
        # or
        #   {"prompt": "...", "completion": "..."}
        # Adapt below to your actual schema once it's published.
        if "messages" in ex:
            text = tokenizer.apply_chat_template(
                ex["messages"], tokenize=False, add_generation_prompt=False
            )
        elif "prompt" in ex and "completion" in ex:
            text = tokenizer.apply_chat_template(
                [
                    {"role": "user", "content": ex["prompt"]},
                    {"role": "assistant", "content": ex["completion"]},
                ],
                tokenize=False,
                add_generation_prompt=False,
            )
        else:
            raise ValueError(f"Unknown dataset schema: {list(ex.keys())}")
        return {"text": text}

    ds = ds.map(format_example, remove_columns=ds.column_names)

    # ── Trainer ──────────────────────────────────────────────────
    output_dir = f"{ADAPTER_PATH}/{hf_repo.replace('/', '__')}"

    config = SFTConfig(
        output_dir=output_dir,
        num_train_epochs=num_train_epochs,
        per_device_train_batch_size=per_device_train_batch_size,
        gradient_accumulation_steps=gradient_accumulation_steps,
        learning_rate=learning_rate,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        optim="adamw_8bit",
        weight_decay=0.01,
        logging_steps=5,
        save_steps=save_steps,
        save_total_limit=3,
        bf16=True,
        max_seq_length=max_seq_length,
        dataset_text_field="text",
        packing=False,  # set True if dataset is short examples (saves time)
        report_to=("wandb" if os.environ.get("WANDB_API_KEY") else "none"),
        run_name=f"crimeopus-v2-{int(__import__('time').time())}",
        seed=seed,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        args=config,
    )

    # ── GO ────────────────────────────────────────────────────────
    print("▶ Training started")
    stats = trainer.train()
    print(f"✓ Training done — {stats.metrics}")

    # ── Save final adapter + push to HF ──────────────────────────
    print(f"▶ Saving final adapter to {output_dir}/final")
    model.save_pretrained(f"{output_dir}/final")
    tokenizer.save_pretrained(f"{output_dir}/final")

    print(f"▶ Pushing to https://huggingface.co/{hf_repo}")
    model.push_to_hub(hf_repo, token=os.environ["HF_TOKEN"], private=False)
    tokenizer.push_to_hub(hf_repo, token=os.environ["HF_TOKEN"], private=False)

    # Persist on the Modal volume so we can grab it later if push fails
    adapter_volume.commit()

    print(f"╔══════════════════════════════════════════════════╗")
    print(f"║  ✓ Training complete                             ║")
    print(f"║  Adapter on HF: {hf_repo:33s} ║")
    print(f"║  Local on volume: {output_dir:30s} ║")
    print(f"║  Next: bash merge_lora.sh                        ║")
    print(f"╚══════════════════════════════════════════════════╝")


@app.function(
    image=modal.Image.debian_slim().pip_install("huggingface-hub==0.26.2"),
    secrets=[hf_secret],
)
def smoke_check_dataset(dataset: str = "JollyFraud/crimeopus-distill-v2"):
    """Quick sanity check on the dataset before paying for GPU time."""
    from huggingface_hub import HfApi
    api = HfApi(token=os.environ["HF_TOKEN"])
    info = api.dataset_info(dataset)
    print(f"Dataset: {dataset}")
    print(f"  downloads: {info.downloads}")
    print(f"  tags: {info.tags}")
    print(f"  files: {[f.rfilename for f in info.siblings[:8]]}")


# ── 4. CLI entry ───────────────────────────────────────────────────
@app.local_entrypoint()
def main(
    epochs: int = 3,
    max_seq: int = 8192,
    base: str = "huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated",
    dataset: str = "JollyFraud/crimeopus-distill-v2",
    hf_repo: str = "JollyFraud/crimeopus-v2-lora",
    smoke_only: bool = False,
):
    if smoke_only:
        smoke_check_dataset.remote(dataset)
        return

    smoke_check_dataset.remote(dataset)
    train.remote(
        base_model=base,
        dataset=dataset,
        hf_repo=hf_repo,
        max_seq_length=max_seq,
        num_train_epochs=epochs,
    )
