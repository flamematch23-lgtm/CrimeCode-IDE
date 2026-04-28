/**
 * Telegram Auth Provider for CrimeCode IDE
 * Allows users to authenticate via Telegram bot
 */

export interface TelegramAuthConfig {
  botToken: string
  botUsername: string
}

export interface TelegramUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

export function validateTelegramAuth(initData: string, botToken: string): TelegramUser | null {
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  if (!hash) return null

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")

  const encoder = new TextEncoder()
  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(botToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  ) as CryptoKey

  const signature = crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(dataCheckString)
  ) as ArrayBuffer

  const expectedHash = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")

  if (expectedHash !== hash) return null

  return {
    id: Number(params.get("id")),
    first_name: params.get("first_name") || undefined,
    last_name: params.get("last_name") || undefined,
    username: params.get("username") || undefined,
    photo_url: params.get("photo_url") || undefined,
    auth_date: Number(params.get("auth_date")),
    hash,
  }
}

export const TelegramProvider = (config: TelegramAuthConfig) => {
  return {
    type: "telegram" as const,
    init: (route: any) => {
      const user = validateTelegramAuth(route.data || "", config.botToken)
      if (!user) throw new Error("Invalid Telegram auth data")
      return {
        id: user.id.toString(),
        email: `${user.username || user.id}@telegram.user`,
        name: [user.first_name, user.last_name].filter(Boolean).join(" "),
      }
    },
  }
}

export async function startTelegramAuth(botToken: string, deviceLabel: string): Promise<{ pin: string; bot_url: string; expires_at: number }> {
  const pin = Math.floor(100000 + Math.random() * 900000).toString()
  const expires_at = Date.now() + 5 * 60 * 1000 // 5 minutes
  
  return {
    pin,
    bot_url: `https://t.me/CrimeCodeSub_bot?start=${pin}`,
    expires_at,
  }
}

export async function pollTelegramAuth(pin: string): Promise<
  | { status: "pending" }
  | { status: "ok"; token: string; exp: number; customer_id: string }
  | { status: "expired" }
  | { status: "rejected"; reason?: string }
> {
  // Implementation would poll the backend for PIN status
  return { status: "pending" }
}
