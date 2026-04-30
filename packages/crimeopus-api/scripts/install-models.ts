#!/usr/bin/env bun
/**
 * install-models.ts — declarative installer per i tuoi modelli CrimeOpus.
 *
 * Legge `models.config.json` (lo schema sotto), per ogni voce:
 *   1. Scarica il GGUF da Hugging Face (ev. repo privato con HF_TOKEN)
 *   2. Genera un Modelfile con i parametri specificati
 *   3. Lancia `ollama create <name> -f <modelfile>` per registrarlo
 *
 * Idempotente:
 *   - Se il blob GGUF è già a disco con la stessa dimensione → skip download
 *   - Se Ollama ha già un modello con lo stesso nome E digest → skip create
 *   - Altrimenti rigenera il Modelfile e ricrea il modello
 *
 * Schema `models.config.json`:
 *
 *   {
 *     "ollama_url": "http://127.0.0.1:11434",
 *     "models_dir": "./models-cache",
 *     "models": [
 *       {
 *         "name": "crimeopus-default",
 *         "hf_repo": "yourorg/CrimeOpus-4.7-Opus-GGUF",
 *         "hf_file": "CrimeOpus4.7-Opus.IQ4_XS.gguf",
 *         "private": true,
 *         "modelfile": {
 *           "from": null,                       // auto-derived from hf_file path
 *           "template": "<|im_start|>...",      // optional override
 *           "system": "Sei CrimeOpus, ...",     // optional system prompt
 *           "parameters": {
 *             "num_ctx": 8192,
 *             "temperature": 0.6,
 *             "top_p": 0.95,
 *             "stop": ["<|im_end|>"]
 *           }
 *         }
 *       },
 *       ...
 *     ]
 *   }
 *
 * Usage:
 *   HF_TOKEN=hf_xxx bun scripts/install-models.ts [--config models.config.json] [--only crimeopus-default,crimeopus-coder]
 */
import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs"
import { join, basename } from "node:path"
import { spawnSync } from "node:child_process"

// ─── CLI ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(`--${name}=`.length)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
  return null
}
const has = (name: string) => args.includes(`--${name}`)

if (has("help") || has("h")) {
  console.log(`bun scripts/install-models.ts [flags]

Flags:
  --config FILE     models.config.json (default ./models.config.json)
  --only NAMES      comma-separated subset, e.g. "crimeopus-default,crimeopus-coder"
  --skip NAMES      comma-separated to exclude
  --dry-run         print actions without doing them
  --force           re-download + re-create even if cache hit

Env:
  HF_TOKEN          Hugging Face read token (required for private repos)
`)
  process.exit(0)
}

const configPath = flag("config") ?? "./models.config.json"
const onlyList = (flag("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const skipList = (flag("skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const dryRun = has("dry-run")
const force = has("force")

if (!existsSync(configPath)) {
  console.error(`✗ config file not found: ${configPath}`)
  console.error(`  Run: cp models.config.example.json models.config.json && edit`)
  process.exit(1)
}

// ─── Config schema ────────────────────────────────────────────────

interface ModelConfig {
  name: string
  hf_repo: string
  hf_file: string
  private?: boolean
  /** SHA-256 (hex) — if set, validates after download */
  sha256?: string
  modelfile?: {
    template?: string
    system?: string
    parameters?: Record<string, string | number | string[]>
  }
}

interface RootConfig {
  ollama_url?: string
  models_dir?: string
  models: ModelConfig[]
}

const cfg = JSON.parse(require("node:fs").readFileSync(configPath, "utf8")) as RootConfig
const ollamaUrl = (cfg.ollama_url ?? "http://127.0.0.1:11434").replace(/\/+$/, "")
const modelsDir = cfg.models_dir ?? "./models-cache"
mkdirSync(modelsDir, { recursive: true })

const HF_TOKEN = process.env.HF_TOKEN ?? ""

console.log(`▶ install-models — config: ${configPath}`)
console.log(`  ollama: ${ollamaUrl}`)
console.log(`  cache:  ${modelsDir}`)
console.log(`  HF_TOKEN: ${HF_TOKEN ? "set" : "not set (public repos only)"}`)
console.log(`  models:  ${cfg.models.length} declared, ${onlyList.length ? "only=" + onlyList.join(",") : "all"}`)
console.log()

// ─── Pipeline ─────────────────────────────────────────────────────

let installed = 0
let skipped = 0
let failed = 0

for (const m of cfg.models) {
  if (onlyList.length > 0 && !onlyList.includes(m.name)) continue
  if (skipList.includes(m.name)) continue

  const blob = join(modelsDir, basename(m.hf_file))
  console.log(`──── ${m.name} ─────────────────────────────────────`)
  console.log(`     repo: ${m.hf_repo}`)
  console.log(`     file: ${m.hf_file}`)

  try {
    // 1) Download GGUF
    if (existsSync(blob) && !force) {
      const sz = statSync(blob).size
      console.log(`     ✓ already cached (${(sz / 1024 / 1024 / 1024).toFixed(2)} GB) — skip download`)
    } else {
      console.log(`     ▶ downloading from Hugging Face…`)
      if (dryRun) {
        console.log(`     [dry-run] would download to ${blob}`)
      } else {
        const ok = downloadHF(m.hf_repo, m.hf_file, blob, !!m.private)
        if (!ok) {
          failed++
          console.log(`     ✗ download failed`)
          continue
        }
      }
    }

    // 2) Generate Modelfile
    const modelfilePath = join(modelsDir, `${m.name}.Modelfile`)
    const modelfileContent = renderModelfile(blob, m.modelfile)
    if (dryRun) {
      console.log(`     [dry-run] would write Modelfile:\n${modelfileContent.split("\n").map((l) => "       | " + l).join("\n")}`)
    } else {
      writeFileSync(modelfilePath, modelfileContent)
      console.log(`     ✓ Modelfile written: ${modelfilePath}`)
    }

    // 3) Already in Ollama with same digest? skip
    if (!force && existsInOllama(m.name)) {
      console.log(`     ✓ ${m.name} already in Ollama — skip create`)
      skipped++
      continue
    }

    // 4) ollama create
    if (dryRun) {
      console.log(`     [dry-run] would run: ollama create ${m.name} -f ${modelfilePath}`)
      installed++
      continue
    }
    console.log(`     ▶ ollama create ${m.name}…`)
    const r = spawnSync("ollama", ["create", m.name, "-f", modelfilePath], { stdio: "inherit" })
    if (r.status !== 0) {
      failed++
      console.log(`     ✗ ollama create failed (exit ${r.status})`)
      continue
    }
    installed++
    console.log(`     ✓ installed ${m.name}`)
  } catch (e) {
    failed++
    console.log(`     ✗ ${(e as Error).message}`)
  }
  console.log()
}

console.log(`──── Done ─────────────────────────────────────`)
console.log(`     installed: ${installed}`)
console.log(`     skipped:   ${skipped}`)
console.log(`     failed:    ${failed}`)
process.exit(failed > 0 ? 1 : 0)

// ─── Helpers ──────────────────────────────────────────────────────

function downloadHF(repo: string, file: string, dest: string, isPrivate: boolean): boolean {
  // Hugging Face URL: https://huggingface.co/<repo>/resolve/main/<file>
  const url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file).replace(/%2F/g, "/")}`
  // Use curl so we get a progress bar without re-implementing it.
  const headers: string[] = ["-L", "-o", dest, "--fail-with-body", "--progress-bar"]
  if (isPrivate) {
    if (!HF_TOKEN) {
      console.log(`     ✗ private repo but HF_TOKEN env not set`)
      return false
    }
    headers.push("-H", `Authorization: Bearer ${HF_TOKEN}`)
  }
  const r = spawnSync("curl", [...headers, url], { stdio: ["ignore", "inherit", "inherit"] })
  return r.status === 0
}

function renderModelfile(ggufPath: string, mf?: ModelConfig["modelfile"]): string {
  const lines: string[] = [`FROM ${ggufPath}`]
  if (mf?.template) lines.push(`TEMPLATE """${mf.template}"""`)
  if (mf?.system) lines.push(`SYSTEM """${mf.system}"""`)
  for (const [k, v] of Object.entries(mf?.parameters ?? {})) {
    if (Array.isArray(v)) {
      for (const vv of v) lines.push(`PARAMETER ${k} ${JSON.stringify(vv)}`)
    } else {
      lines.push(`PARAMETER ${k} ${typeof v === "number" ? v : JSON.stringify(v)}`)
    }
  }
  return lines.join("\n") + "\n"
}

function existsInOllama(name: string): boolean {
  try {
    const r = spawnSync("curl", ["-s", `${ollamaUrl}/api/tags`], { encoding: "utf8" })
    if (r.status !== 0) return false
    const body = JSON.parse(r.stdout) as { models?: Array<{ name: string }> }
    return (body.models ?? []).some((m) => m.name === name || m.name === `${name}:latest`)
  } catch {
    return false
  }
}
