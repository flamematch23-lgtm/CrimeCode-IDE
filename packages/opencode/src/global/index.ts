import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"

const app = "openworm"

const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

// First-launch config seeder.
//
// Quando un utente nuovo installa CrimeCode IDE da .exe, di default NON c'è
// nessun config file in %LOCALAPPDATA%\openworm\. Il provider picker mostra
// solo i modelli dei provider con apiKey configurato — risultato: schermo
// vuoto al primo avvio, l'utente non sa cosa fare.
//
// Questo seeder scrive un `openworm.jsonc` di default SOLO se non esiste già
// nessun config (zero risk di sovrascrivere setup esistenti). Il file:
//   - Espone OpenCode Zen (UI mostra "Accedi" per ottenere API key)
//   - Pre-include i provider free / freemium più popolari così l'utente
//     vede subito modelli da provare
//   - È full-commented così l'utente capisce dove modificare
;(async () => {
  const candidates = [
    "openworm.jsonc",
    "openworm.json",
    "opencode.jsonc",
    "opencode.json",
    "config.json",
  ].map((f) => path.join(config, f))

  const anyExists = await Promise.all(
    candidates.map(async (p) => {
      try {
        await fs.access(p)
        return true
      } catch {
        return false
      }
    }),
  ).then((results) => results.some(Boolean))

  if (anyExists) return

  const seed = `// CrimeCode IDE — config di default generato al primo avvio.
//
// Questo file contiene i provider AI pre-abilitati e impostazioni iniziali.
// Modificalo per aggiungere i tuoi API key, abilitare/disabilitare provider,
// o impostare il modello di default.
//
// Documentazione: https://opencode.ai/config.json
{
  "$schema": "https://opencode.ai/config.json",

  // Provider pre-elencati e visibili nel selector di modello.
  // - 'opencode' (OpenCode Zen): hub modelli curati. Accedi via UI per
  //   ottenere API key e usare tutti i modelli inclusi.
  // - 'crimeopus' (CrimeCode Cloud): gateway con failover Together/Groq/
  //   Modal. Già configurato verso https://ai.crimecode.cc.
  // - 'groq': free tier generoso (LLaMA, Mixtral, Gemma).
  // - 'cerebras': free tier API (LLaMA 3.1 70B, 8B).
  // - 'together': accesso a modelli open-source (Qwen, DeepSeek, LLaMA).
  // - 'google': Gemini 2.0/2.5 Flash con free tier.
  "enabled_providers": [
    "opencode",
    "crimeopus",
    "groq",
    "cerebras",
    "together",
    "google",
    "anthropic",
    "openai",
    "openrouter"
  ],

  // Configurazione provider. Aggiungi 'apiKey' nel blocco 'options' per
  // attivare il provider. Senza apiKey il provider rimane visibile nel
  // selector ma chiamarlo restituirà errore di auth.
  "provider": {
    "opencode": {
      // Sign in via UI (Settings → Providers → OpenCode Zen). L'API key
      // verrà salvata in modo sicuro nel keystore di sistema.
      "options": {}
    },
    "crimeopus": {
      // Gateway pre-configurato. Sostituisci con il tuo API key personale
      // se sei abbonato al piano CrimeCode Cloud.
      "options": {
        "baseURL": "https://ai.crimecode.cc/v1"
      }
    }
  }
}
`

  const target = path.join(config, "openworm.jsonc")
  try {
    await fs.writeFile(target, seed, "utf8")
  } catch {
    // Non-fatal: se non possiamo scrivere il seed, il sidecar parte
    // comunque con config vuoto. L'utente può sempre creare il file a mano.
  }
})().catch(() => {})

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Global.Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Global.Path.cache, "version"), CACHE_VERSION)
}
