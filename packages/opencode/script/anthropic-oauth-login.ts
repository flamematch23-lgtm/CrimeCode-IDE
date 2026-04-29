#!/usr/bin/env bun
/**
 * anthropic-oauth-login.ts — login Pro/Max manuale, senza dialog UI.
 *
 * Per quando il dialog dell'app o l'endpoint Anthropic stanno facendo i
 * capricci. Lo script:
 *   1. Genera PKCE (verifier + challenge) e state CSRF
 *   2. Stampa l'URL di authorize — apri nel browser, autorizza,
 *      copia il code mostrato sulla pagina di callback
 *   3. Incolla il code nello script (supporta sia "code" che "code#state")
 *   4. POST diretto a console.anthropic.com/v1/oauth/token con il
 *      code_verifier corretto
 *   5. Scrive i token in auth.json di OpenCode (nel posto giusto su
 *      Windows/macOS/Linux), pronti per essere usati al prossimo avvio
 *
 * Uso:
 *   bun packages/opencode/script/anthropic-oauth-login.ts
 *
 * Note:
 *   - Niente rate-limit loop: facciamo UNA sola POST al token endpoint.
 *   - I token (access + refresh) vengono salvati con permessi 0600.
 *   - Se hai già un'auth.json esistente, viene aggiornata solo la chiave
 *     "anthropic" (le altre provider restano intatte).
 */
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"

// --- OAuth client constants (same as the bundled Anthropic plugin) ----------
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPES = "org:create_api_key user:profile user:inference"

// --- Helpers -----------------------------------------------------------------
function rand(len: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let out = ""
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = rand(64, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(hash) }
}

function authJsonPath(): string {
  // Same logic as Global.Path.data + auth.json in opencode/src/auth/index.ts
  // and global/index.ts: it joins xdgData with "openworm".
  // On Windows, xdg-basedir defaults to %LOCALAPPDATA% but the OpenCode
  // codebase prefers the standard "$HOME/.local/share" path. We honour both.
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return join(base, "openworm", "auth.json")
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim()
}

// --- Main flow --------------------------------------------------------------
async function main() {
  const rl = createInterface({ input, output })

  const { verifier, challenge } = await pkce()
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer)

  const url =
    AUTHORIZE_URL +
    "?" +
    new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString()

  console.log()
  console.log("════════════════════════════════════════════════════════════════")
  console.log("  Anthropic OAuth login per OpenCode (Claude Pro / Max)")
  console.log("════════════════════════════════════════════════════════════════")
  console.log()
  console.log("1. Apri questo URL nel browser e autorizza:")
  console.log()
  console.log("   " + url)
  console.log()
  console.log("2. Copia il code dalla pagina di callback (forma 'CODE#STATE')")
  console.log()

  const pasted = await ask(rl, "Incolla qui il code: ")
  rl.close()

  if (!pasted) {
    console.error("✗ Nessun code inserito.")
    process.exit(2)
  }

  const [authCode, pastedState] = pasted.includes("#") ? pasted.split("#") : [pasted, undefined]
  if (pastedState && pastedState !== state) {
    console.error(
      `✗ State mismatch — il code che hai incollato appartiene a un'altra sessione.\n` +
        `  expected="${state.slice(0, 12)}…"  got="${pastedState.slice(0, 12)}…"\n` +
        `  Rilancia lo script per generare un nuovo URL.`,
    )
    process.exit(1)
  }

  console.log()
  console.log("→ Token exchange…")

  const reqBody = {
    grant_type: "authorization_code",
    code: authCode,
    state,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "opencode-cli-login/1.0",
    },
    body: JSON.stringify(reqBody),
  })

  const text = await res.text()

  if (!res.ok) {
    let detail = text.slice(0, 400)
    try {
      const j = JSON.parse(text)
      if (j.error_description) detail = j.error_description
      else if (j.error?.message) detail = j.error.message
      else if (typeof j.error === "string") detail = j.error
      else if (j.message) detail = j.message
    } catch {}

    if (res.status === 429) {
      console.error()
      console.error(`✗ Anthropic ti sta rate-limitando (429).`)
      console.error(`  Aspetta 1–2 ore o cambia IP (mobile hotspot / VPN diversa) e rilancia lo script.`)
      console.error(`  Dettaglio: ${detail}`)
    } else if (res.status === 400 && /invalid_grant|invalid 'code'/i.test(detail)) {
      console.error()
      console.error(`✗ Code OAuth scaduto o già usato (400 invalid_grant).`)
      console.error(`  I code durano ~30s–2min. Rilancia lo script e questa volta`)
      console.error(`  copia/incolla il code IMMEDIATAMENTE dopo aver autorizzato.`)
      console.error(`  Dettaglio: ${detail}`)
    } else {
      console.error(`✗ Token exchange fallito (${res.status}): ${detail}`)
    }
    process.exit(1)
  }

  let tokens: { access_token: string; refresh_token: string; expires_in?: number; token_type?: string; scope?: string }
  try {
    tokens = JSON.parse(text)
  } catch {
    console.error(`✗ Anthropic ha risposto 200 ma il body non è JSON: ${text.slice(0, 200)}`)
    process.exit(1)
  }

  if (!tokens.access_token || !tokens.refresh_token) {
    console.error(`✗ Risposta inattesa, mancano access_token / refresh_token: ${text.slice(0, 200)}`)
    process.exit(1)
  }

  // Write to auth.json
  const path = authJsonPath()
  mkdirSync(dirname(path), { recursive: true })

  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      existing = {}
    }
  }

  existing["anthropic"] = {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }

  writeFileSync(path, JSON.stringify(existing, null, 2), { mode: 0o600 })

  console.log()
  console.log("✓ Login Anthropic OAuth completato.")
  console.log(`  Tokens salvati in: ${path}`)
  console.log(`  Validi per: ${tokens.expires_in ?? 3600}s (~${Math.round((tokens.expires_in ?? 3600) / 60)} min)`)
  console.log(`  Scope: ${tokens.scope ?? "(default)"}`)
  console.log(`  Refresh token presente: ${tokens.refresh_token ? "sì" : "no"}`)
  console.log()
  console.log("→ Riavvia OpenCode. Il provider Anthropic userà i token Pro/Max.")
}

main().catch((err) => {
  console.error()
  console.error(`✗ Errore: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
