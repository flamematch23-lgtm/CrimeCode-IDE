import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { Auth, OAUTH_DUMMY_KEY } from "../auth"
import { Installation } from "../installation"

const log = Log.create({ service: "plugin.anthropic" })

// Claude.ai / Claude Code OAuth client used for Pro / Max / Team / Enterprise subscription auth
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
// The token endpoint is still served from console.anthropic.com even though
// the user-facing callback page now lives on platform.claude.com. This is
// confirmed by Claude Code CLI's own implementation.
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const OAUTH_SCOPES = "org:create_api_key user:profile user:inference"
// Beta header required when authenticating Anthropic API calls with an OAuth access token
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(64)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function buildAuthorizeUrl(pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  token_type?: string
  scope?: string
}

/**
 * Exchange an authorization code for an access + refresh token.
 *
 * The user typically pastes the value shown on the callback page, which is
 * formatted as `<code>#<state>` (Anthropic encodes both into one string so
 * the user only has to copy a single chunk). We split on `#` and pass the
 * code; the state is verified against the originator's expected state and
 * is intentionally NOT included in the token request body — OAuth2 standard
 * uses state only for CSRF in the redirect, not in the token exchange.
 */
async function exchangeCodeForTokens(
  rawInput: string,
  pkce: PkceCodes,
  expectedState: string,
): Promise<TokenResponse> {
  const trimmed = rawInput.trim()
  let authCode: string
  let pastedState: string | undefined
  if (trimmed.includes("#")) {
    const parts = trimmed.split("#")
    authCode = parts[0]
    pastedState = parts.slice(1).join("#") // tolerate accidental `#` in state
  } else {
    authCode = trimmed
    pastedState = undefined
  }

  // CSRF check — if the user got a different state back, abort early
  if (pastedState !== undefined && pastedState !== expectedState) {
    throw new Error(
      `OAuth state mismatch: pasted code returned a different state than authorize. ` +
        `This usually means a stale code from a previous attempt — start the flow again. ` +
        `(expected="${expectedState.slice(0, 8)}…", got="${pastedState.slice(0, 8)}…")`,
    )
  }

  // Try with `state` in the body first (current Anthropic schema requires it).
  // If we somehow get an "Invalid request format" back, retry without `state`
  // — observed live, both shapes have been accepted at different points.
  const baseBody = {
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
  }

  log.info("anthropic token exchange request", {
    url: TOKEN_URL,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_prefix: authCode.slice(0, 8),
    code_verifier_len: pkce.verifier.length,
    state_pasted: pastedState !== undefined,
    state_match: pastedState === undefined ? null : pastedState === expectedState,
  })

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `opencode/${Installation.VERSION} (+https://opencode.ai)`,
  }

  // Attempt #1: include state
  let response = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...baseBody, state: expectedState }),
  })
  let firstAttemptText = ""
  if (!response.ok) {
    firstAttemptText = await response.text().catch(() => "")
    const isFormatError = /invalid request format/i.test(firstAttemptText)
    if (isFormatError) {
      log.warn("anthropic token exchange — body with state rejected, retrying without", {
        status: response.status,
      })
      // Attempt #2: same body, no state
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(baseBody),
      })
    }
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => "")) || firstAttemptText
    log.error("anthropic token exchange failed", {
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 1024),
    })
    let detail = text.slice(0, 200)
    try {
      const j = JSON.parse(text)
      if (j.error_description) detail = j.error_description
      else if (j.error?.message) detail = j.error.message
      else if (typeof j.error === "string") detail = j.error
      else if (j.message) detail = j.message
    } catch {
      /* not JSON — leave the truncated text */
    }

    // Friendlier messages for the most common failure modes the user hits
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after")
      const wait = retryAfter ? `attendi ${retryAfter}s` : "attendi qualche minuto"
      throw new Error(
        `Anthropic ha applicato un rate-limit (429) sul token endpoint — ${wait} ` +
          `e riprova generando un NUOVO code (quelli OAuth scadono in ~2 minuti). ` +
          `Se sei dietro VPN o proxy condiviso, prova senza. Dettaglio: ${detail}`,
      )
    }
    if (response.status === 400 && /invalid_grant|invalid 'code'/i.test(detail)) {
      throw new Error(
        `Code OAuth non valido o scaduto (400 invalid_grant). ` +
          `Chiudi questo dialog, riapri "Accedi con Claude Pro/Max", clicca "questo link" ` +
          `e incolla il NUOVO codice qui SUBITO (i code scadono in pochi secondi). ` +
          `Dettaglio: ${detail}`,
      )
    }

    throw new Error(`Anthropic token exchange ${response.status}: ${detail}`)
  }

  return (await response.json()) as TokenResponse
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `opencode/${Installation.VERSION} (+https://opencode.ai)`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    log.error("anthropic token refresh failed", {
      status: response.status,
      body: text.slice(0, 512),
    })
    throw new Error(`Anthropic token refresh ${response.status}: ${text.slice(0, 200)}`)
  }
  return (await response.json()) as TokenResponse
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        return {
          // The Anthropic AI SDK requires *some* apiKey value to construct the client.
          // We hand it a dummy and strip the x-api-key header inside our custom fetch.
          apiKey: OAUTH_DUMMY_KEY,
          headers: {
            // Beta flag required by Anthropic when calling the API with an OAuth Bearer token
            "anthropic-beta": `${ANTHROPIC_OAUTH_BETA},interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`,
          },
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Strip the dummy x-api-key the SDK injects — OAuth uses Bearer instead
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("x-api-key")
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) =>
                    key.toLowerCase() !== "x-api-key" && key.toLowerCase() !== "authorization",
                )
              } else {
                delete init.headers["x-api-key"]
                delete init.headers["X-Api-Key"]
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            let currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Refresh the token if it has expired (with a 1-minute safety window)
            if (!currentAuth.access || currentAuth.expires < Date.now() + 60_000) {
              log.info("refreshing anthropic access token")
              try {
                const tokens = await refreshAccessToken(currentAuth.refresh)
                const updated = {
                  type: "oauth" as const,
                  access: tokens.access_token,
                  refresh: tokens.refresh_token ?? currentAuth.refresh,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                }
                await input.client.auth.set({
                  path: { id: "anthropic" },
                  body: updated,
                })
                currentAuth = { ...currentAuth, ...updated }
              } catch (err) {
                log.error("failed to refresh anthropic token", { error: err })
                throw err
              }
            }

            // Build the final headers, ensuring Bearer auth + beta flag are present
            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            headers.set("authorization", `Bearer ${currentAuth.access}`)

            // Make sure the OAuth beta flag is present (merge with any existing values)
            const existingBeta = headers.get("anthropic-beta")
            if (!existingBeta) {
              headers.set("anthropic-beta", ANTHROPIC_OAUTH_BETA)
            } else if (!existingBeta.includes(ANTHROPIC_OAUTH_BETA)) {
              headers.set("anthropic-beta", `${ANTHROPIC_OAUTH_BETA},${existingBeta}`)
            }

            // Inject the Claude-Code identity prefix into the system prompt.
            //
            // Anthropic enforces this for OAuth Pro/Max tokens: if the system
            // prompt's FIRST BLOCK is not exactly
            //   "You are Claude Code, Anthropic's official CLI for Claude."
            // the API responds with 429 rate_limit_error (a misleading status
            // — it's actually an authorization gate). Verified live across
            // Sonnet 4.5 / Opus 4.1: 429 without prefix, 200 with prefix.
            //
            // The trick: the prefix MUST live in its own array block. If we
            // concatenate it to the user's system prompt as a single string
            // ("prefix\n\nuser content"), Anthropic still rejects with 429.
            // Therefore we ALWAYS convert the body's `system` field into an
            // array form with the prefix as the first block.
            //
            // Only POSTs to /v1/messages are affected.
            let body: BodyInit | undefined = init?.body ?? undefined
            const url =
              requestInput instanceof URL
                ? requestInput.toString()
                : typeof requestInput === "string"
                  ? requestInput
                  : (requestInput as Request).url
            const isMessages = /\/v1\/messages(?:\?|$)/.test(url) && (init?.method ?? "POST").toUpperCase() === "POST"
            if (isMessages && typeof body === "string") {
              try {
                const parsed = JSON.parse(body) as {
                  system?: string | Array<{ type: string; text: string; cache_control?: unknown }>
                  [key: string]: unknown
                }
                const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
                const prefixBlock = { type: "text" as const, text: CLAUDE_CODE_PREFIX }
                if (parsed.system === undefined) {
                  parsed.system = [prefixBlock]
                } else if (typeof parsed.system === "string") {
                  // String form: convert to array with prefix as first block,
                  // user content as second. NEVER concatenate into one string
                  // — Anthropic rejects that with 429.
                  if (parsed.system === CLAUDE_CODE_PREFIX) {
                    parsed.system = [prefixBlock]
                  } else if (parsed.system.startsWith(CLAUDE_CODE_PREFIX)) {
                    const rest = parsed.system.slice(CLAUDE_CODE_PREFIX.length).replace(/^[\s\n]+/, "")
                    parsed.system = rest ? [prefixBlock, { type: "text" as const, text: rest }] : [prefixBlock]
                  } else {
                    parsed.system = [prefixBlock, { type: "text" as const, text: parsed.system }]
                  }
                } else if (Array.isArray(parsed.system)) {
                  const first = parsed.system[0]
                  const firstText = first && typeof first.text === "string" ? first.text : ""
                  if (firstText !== CLAUDE_CODE_PREFIX) {
                    if (firstText.startsWith(CLAUDE_CODE_PREFIX)) {
                      // Split first block: prefix becomes its own block,
                      // remainder stays in the original block (preserving any
                      // cache_control etc. on the second block).
                      const rest = firstText.slice(CLAUDE_CODE_PREFIX.length).replace(/^[\s\n]+/, "")
                      const tail = rest ? [{ ...first, text: rest }, ...parsed.system.slice(1)] : parsed.system.slice(1)
                      parsed.system = [prefixBlock, ...tail]
                    } else {
                      parsed.system = [prefixBlock, ...parsed.system]
                    }
                  }
                }
                body = JSON.stringify(parsed)
                // Sync content-length on the new body
                headers.set("content-length", String(Buffer.byteLength(body, "utf8")))
              } catch (err) {
                log.warn("anthropic oauth: could not inject Claude-Code prefix (body not JSON)", {
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }

            return fetch(requestInput, {
              ...init,
              headers,
              body,
            })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro / Max (subscription login)",
          type: "oauth",
          async authorize() {
            // Capture pkce + state in this closure — DO NOT use a module-level
            // variable. The auth framework keeps this closure alive across the
            // authorize → callback round-trip, so we don't need shared state.
            const pkce = await generatePKCE()
            const state = generateState()
            const url = buildAuthorizeUrl(pkce, state)
            log.info("anthropic oauth authorize", {
              state_prefix: state.slice(0, 8),
              challenge_prefix: pkce.challenge.slice(0, 8),
            })

            return {
              url,
              method: "code" as const,
              instructions:
                "Visita il link, accedi con il tuo account Claude Pro/Max, poi incolla qui il codice mostrato sulla pagina (è nella forma 'CODE#STATE' — incolla tutto verbatim).",
              async callback(code: string) {
                try {
                  const tokens = await exchangeCodeForTokens(code, pkce, state)
                  log.info("anthropic oauth success", {
                    expires_in: tokens.expires_in,
                    token_type: tokens.token_type,
                    scope: tokens.scope,
                  })
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  const reason = err instanceof Error ? err.message : String(err)
                  log.error("anthropic oauth callback error", { error: reason })
                  // Returning `reason` makes the UI show the actual upstream
                  // failure (e.g. "Anthropic token exchange 400: invalid_grant
                  // — Invalid 'code' in request.") instead of a generic
                  // "codice non valido".
                  return { type: "failed" as const, reason }
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
