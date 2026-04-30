#!/usr/bin/env bun
/**
 * setup.ts — wizard interattivo per partire in 60 secondi.
 *
 * Esegui:
 *   bun run setup
 *
 * Ti chiede:
 *   1. Quale provider cloud usi (Together / Groq / OpenRouter / Fireworks / RunPod)
 *   2. La tua API key (validata facendo un GET /v1/models)
 *   3. Quali modelli vuoi esporre come "crimeopus-*"
 *   4. Password admin + JWT secret (auto-generati con --auto)
 *   5. Una API key di test
 *
 * Output:
 *   - .env  configurato e funzionante
 *   - catalog.json  con i mapping pubblico → provider model
 *   - Stampa la riga curl di test pronta da eseguire
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline/promises"

interface ProviderPreset {
  id: string
  name: string
  url: string
  /** Curated list of "good" models to expose as CrimeOpus aliases */
  modelChoices: Array<{
    publicId: string
    upstream: string
    display: string
    description?: string
    systemPrefix?: string
  }>
}

const PRESETS: ProviderPreset[] = [
  {
    id: "together",
    name: "Together AI",
    url: "https://api.together.xyz/v1",
    modelChoices: [
      {
        publicId: "crimeopus-default",
        upstream: "Qwen/Qwen2.5-72B-Instruct-Turbo",
        display: "CrimeOpus 4.7 Code Elite",
        description: "Flagship multilingual + reasoning",
      },
      {
        publicId: "crimeopus-coder",
        upstream: "Qwen/Qwen2.5-Coder-32B-Instruct",
        display: "CrimeOpus 4.7 CODER",
        description: "Code generation specialist",
        systemPrefix: "Sei CrimeOpus CODER. Genera codice idiomatico e conciso.",
      },
      {
        publicId: "crimeopus-think-high",
        upstream: "deepseek-ai/DeepSeek-R1",
        display: "CrimeOpus 4.7 Reasoning · High",
        description: "Maximum reasoning effort",
      },
      {
        publicId: "crimeopus-fast",
        upstream: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        display: "CrimeOpus 4.7 FAST",
        description: "Latency-optimized 70B",
      },
      {
        publicId: "crimeopus-italian",
        upstream: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        display: "CrimeOpus 4.7 Italiano",
        description: "Italian-tuned",
        systemPrefix: "Rispondi sempre in italiano fluente.",
      },
    ],
  },
  {
    id: "groq",
    name: "Groq (super veloce, LPU)",
    url: "https://api.groq.com/openai/v1",
    modelChoices: [
      {
        publicId: "crimeopus-fast",
        upstream: "llama-3.3-70b-versatile",
        display: "CrimeOpus 4.7 FAST (Groq LPU)",
        description: "500+ tok/s su LPU",
      },
      {
        publicId: "crimeopus-default",
        upstream: "llama-3.3-70b-versatile",
        display: "CrimeOpus 4.7 (Groq)",
      },
      {
        publicId: "crimeopus-coder",
        upstream: "qwen/qwen3-32b",
        display: "CrimeOpus 4.7 CODER (Groq)",
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter (aggregatore, paghi solo per token)",
    url: "https://openrouter.ai/api/v1",
    modelChoices: [
      {
        publicId: "crimeopus-default",
        upstream: "qwen/qwen-2.5-72b-instruct",
        display: "CrimeOpus 4.7 (OpenRouter)",
      },
      {
        publicId: "crimeopus-think-high",
        upstream: "deepseek/deepseek-r1",
        display: "CrimeOpus 4.7 Reasoning · High",
      },
      {
        publicId: "crimeopus-coder",
        upstream: "qwen/qwen-2.5-coder-32b-instruct",
        display: "CrimeOpus 4.7 CODER",
      },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    url: "https://api.fireworks.ai/inference/v1",
    modelChoices: [
      {
        publicId: "crimeopus-default",
        upstream: "accounts/fireworks/models/qwen2p5-72b-instruct",
        display: "CrimeOpus 4.7 (Fireworks)",
      },
      {
        publicId: "crimeopus-coder",
        upstream: "accounts/fireworks/models/qwen2p5-coder-32b-instruct",
        display: "CrimeOpus 4.7 CODER",
      },
    ],
  },
  {
    id: "runpod",
    name: "RunPod Serverless (TUOI modelli custom)",
    url: "https://api.runpod.ai/v2/__ENDPOINT_ID__/openai/v1",
    modelChoices: [
      {
        publicId: "crimeopus-default",
        upstream: "crimeopus-default",
        display: "CrimeOpus 4.7 (RunPod)",
      },
    ],
  },
]

const args = process.argv.slice(2)
const auto = args.includes("--auto")
const force = args.includes("--force")

const ENV_PATH = ".env"
const CATALOG_PATH = "catalog.json"

if (existsSync(ENV_PATH) && !force) {
  console.error(`✗ ${ENV_PATH} esiste già. Usa --force per sovrascrivere.`)
  process.exit(1)
}
if (existsSync(CATALOG_PATH) && !force) {
  console.error(`✗ ${CATALOG_PATH} esiste già. Usa --force per sovrascrivere.`)
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })

async function ask(prompt: string, def?: string): Promise<string> {
  if (auto && def) return def
  const a = await rl.question(`${prompt}${def ? ` [${def}]` : ""}: `)
  return a.trim() || def || ""
}

async function askYesNo(prompt: string, def = true): Promise<boolean> {
  if (auto) return def
  const a = await rl.question(`${prompt} [${def ? "Y/n" : "y/N"}]: `)
  if (!a.trim()) return def
  return /^y(es)?$/i.test(a.trim())
}

async function pickPreset(): Promise<ProviderPreset> {
  if (auto) return PRESETS[0]!
  console.log("\nProvider disponibili:\n")
  PRESETS.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}  →  ${p.url}`))
  console.log()
  while (true) {
    const a = await rl.question("Scegli un provider [1]: ")
    const n = a.trim() === "" ? 1 : Number(a)
    if (Number.isFinite(n) && n >= 1 && n <= PRESETS.length) return PRESETS[n - 1]!
    console.log(`  Inserisci un numero da 1 a ${PRESETS.length}.`)
  }
}

async function validateApiKey(url: string, apiKey: string): Promise<{ ok: boolean; modelCount?: number; err?: string }> {
  try {
    const r = await fetch(`${url}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return { ok: false, err: `HTTP ${r.status}: ${await r.text().catch(() => "")}` }
    const body = (await r.json()) as { data?: unknown[] }
    return { ok: true, modelCount: body.data?.length ?? 0 }
  } catch (e) {
    return { ok: false, err: (e as Error).message }
  }
}

console.log(`\n┌─────────────────────────────────────────────────┐`)
console.log(`│  CrimeOpus API · setup wizard                    │`)
console.log(`│  Configura il gateway in 60 secondi              │`)
console.log(`└─────────────────────────────────────────────────┘\n`)

const preset = await pickPreset()
console.log(`\n→ Provider: ${preset.name}`)

let apiKey = ""
let providerUrl = preset.url

if (preset.id === "runpod") {
  const endpointId = await ask("RunPod endpoint id (l'ID Serverless del tuo endpoint)")
  if (!endpointId) {
    console.error("✗ endpoint id obbligatorio per RunPod")
    process.exit(1)
  }
  providerUrl = preset.url.replace("__ENDPOINT_ID__", endpointId)
}

while (true) {
  apiKey = await ask(`API key di ${preset.name}`)
  if (!apiKey) {
    console.log("  ✗ API key obbligatoria")
    continue
  }
  if (auto) break
  console.log("  ▶ verifico la chiave…")
  const v = await validateApiKey(providerUrl, apiKey)
  if (v.ok) {
    console.log(`  ✓ chiave valida (${v.modelCount} modelli accessibili)`)
    break
  }
  console.log(`  ✗ ${v.err}`)
  if (!(await askYesNo("Riprovare?"))) {
    console.log("  Continuo lo stesso (validazione skip)")
    break
  }
}

// Modelli da esporre
console.log(`\nModelli disponibili come alias CrimeOpus:\n`)
preset.modelChoices.forEach((m, i) =>
  console.log(`  ${i + 1}) ${m.publicId.padEnd(22)} → ${m.upstream}\n     ${m.display}${m.description ? " · " + m.description : ""}`),
)

const useAll = auto || (await askYesNo("\nEsporli tutti?", true))
let selected = preset.modelChoices
if (!useAll) {
  const csv = await ask("Numeri (es. 1,3,5)")
  const idx = csv
    .split(",")
    .map((s) => Number(s.trim()) - 1)
    .filter((n) => n >= 0 && n < preset.modelChoices.length)
  selected = idx.map((i) => preset.modelChoices[i]!)
}

// Auth
const adminPassword = randomBytes(16).toString("hex")
const jwtSecret = randomBytes(32).toString("hex")
const testKey = "sk-" + randomBytes(20).toString("hex")

console.log(`\n→ Generazione credenziali admin + chiave di test…`)
console.log(`  Admin password: ${adminPassword}`)
console.log(`  JWT secret:     ${jwtSecret.slice(0, 16)}…`)
console.log(`  Test API key:   ${testKey}`)

// Concurrency
const maxInflight = Number((await ask("Slot concorrenti per provider", "10")) || 10)
const perKey = Number((await ask("Slot concorrenti per chiave", "2")) || 2)

// Whisper
const setupWhisper = await askYesNo("\nConfigurare Whisper STT (Groq Whisper free tier)?", false)
let whisperBlock = ""
if (setupWhisper) {
  const groqKey = await ask("Groq API key (o lascia vuoto per skip)")
  if (groqKey) {
    whisperBlock = `\n# ── Whisper STT (Groq) ────────────────────────────────────\nWHISPER_URL=https://api.groq.com/openai\nWHISPER_API_KEY=${groqKey}\nWHISPER_MODEL_DEFAULT=whisper-large-v3-turbo`
  }
}

// Build .env
const envOut = `# Generato da setup wizard il ${new Date().toISOString()}
# Provider: ${preset.name}

PORT=8787
BIND=0.0.0.0

# ── Provider pool ────────────────────────────────────────────────
UPSTREAM_PROVIDERS=${JSON.stringify([
  {
    id: preset.id,
    kind: "openai",
    url: providerUrl,
    apiKey,
    weight: 1,
    maxInflight,
  },
])}

# ── Auth ─────────────────────────────────────────────────────────
API_KEYS={"${testKey}":"setup-wizard-test"}
JWT_SECRET=${jwtSecret}
ADMIN_PASSWORD=${adminPassword}

# ── Concurrency hardening ────────────────────────────────────────
MAX_CONCURRENCY=${maxInflight}
PER_KEY_CONCURRENCY=${perKey}
QUEUE_MAX=50
QUEUE_TIMEOUT_MS=30000

# ── Rate limit (token bucket) ────────────────────────────────────
RATE_LIMIT_RPM=60
RATE_LIMIT_BURST=10

# ── CORS ─────────────────────────────────────────────────────────
CORS_ORIGINS=*${whisperBlock}

# ── Storage ──────────────────────────────────────────────────────
LOG_DB=./usage.db
CATALOG_PATH=./catalog.json
`

writeFileSync(ENV_PATH, envOut)
console.log(`\n✓ scritto ${ENV_PATH}`)

// Build catalog
const catalogObj: Record<string, unknown> = {
  _comment: `Generato da setup wizard. Modifica liberamente — il provider id "${preset.id}" deve corrispondere a UPSTREAM_PROVIDERS in .env.`,
}
for (const m of selected) {
  catalogObj[m.publicId] = {
    display: m.display,
    description: m.description,
    systemPrefix: m.systemPrefix,
    providers: [{ provider: preset.id, model: m.upstream }],
  }
}
writeFileSync(CATALOG_PATH, JSON.stringify(catalogObj, null, 2))
console.log(`✓ scritto ${CATALOG_PATH} con ${selected.length} modelli`)

console.log(`
─────────────────────────────────────────────────────────
Setup completo. Avvia il server:

  bun run dev

Test rapido:
  curl -H "Authorization: Bearer ${testKey}" \\
       -H "Content-Type: application/json" \\
       -d '{"model":"${selected[0]?.publicId}","messages":[{"role":"user","content":"ciao"}]}' \\
       http://localhost:8787/v1/chat/completions

Apri il dashboard:
  http://localhost:8787/admin
  (user: admin   password: ${adminPassword})

Salva queste credenziali — sono in .env ma è bene averle a mano.
─────────────────────────────────────────────────────────
`)

rl.close()
