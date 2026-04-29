import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { Auth, OAUTH_DUMMY_KEY } from "../auth"

const log = Log.create({ service: "plugin.anthropic" })

// Claude.ai / Claude Code OAuth client used for Pro / Max / Team / Enterprise subscription auth
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
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

async function exchangeCodeForTokens(code: string, pkce: PkceCodes, state: string): Promise<TokenResponse> {
  // Anthropic accepts both `code` and `code#state` formats — split if user pasted the latter
  const [authCode, pastedState] = code.includes("#") ? code.split("#") : [code, state]

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
      state: pastedState,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Anthropic token exchange failed: ${response.status} ${text}`)
  }
  return (await response.json()) as TokenResponse
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Anthropic token refresh failed: ${response.status} ${text}`)
  }
  return (await response.json()) as TokenResponse
}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
}

let pending: PendingOAuth | undefined

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

            return fetch(requestInput, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro / Max (subscription login)",
          type: "oauth",
          async authorize() {
            const pkce = await generatePKCE()
            const state = generateState()
            const url = buildAuthorizeUrl(pkce, state)
            pending = { pkce, state }

            return {
              url,
              method: "code" as const,
              instructions:
                "Open the URL in your browser, sign in with your Claude Pro or Max account, then paste the authorization code shown on the callback page (it may include a #state suffix — paste it verbatim).",
              async callback(code: string) {
                if (!pending) {
                  return { type: "failed" as const }
                }
                try {
                  const { pkce: currentPkce, state: currentState } = pending
                  pending = undefined
                  const tokens = await exchangeCodeForTokens(code.trim(), currentPkce, currentState)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  log.error("anthropic oauth callback failed", { error: err })
                  pending = undefined
                  return { type: "failed" as const }
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
