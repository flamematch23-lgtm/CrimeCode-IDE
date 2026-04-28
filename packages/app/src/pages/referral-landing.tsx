import { onMount, createSignal, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"

/**
 * /r/:code landing page. The referral share-link points here
 * (https://crimecode.cc/r/SHQX3J5X). We:
 *   1. Validate the code shape client-side (cheap regex).
 *   2. Stash it in localStorage with a 30-day TTL so the signup form can
 *      auto-fill it even if the user closes the tab and returns later.
 *   3. Resolve the code against the API to render a friendly preview
 *      (avoids "you got a bonus" lying when the link is bogus).
 *   4. Redirect to / (auth-gate) once the user clicks "Continue" — the
 *      auth-gate detects the stash and pre-fills the signup form.
 *
 * We deliberately don't redirect automatically: a brief landing page
 * gives the user social proof ("Marco invited you — sign up for +3 days
 * trial") and an obvious "Sign up" CTA. Linkbait that auto-redirects
 * tends to be flagged by anti-spam filters and feels untrustworthy.
 */

const STORAGE_KEY = "opencode.referral.code"
const TTL_MS = 30 * 24 * 3600 * 1000

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "https://api.crimecode.cc"

export interface StoredReferral {
  code: string
  savedAt: number
}

/**
 * Read the cached referral code if not expired. Used by auth-gate
 * to pre-fill the signup form even when the user navigates back to
 * the home page before signing up.
 */
export function readStoredReferral(): string | null {
  if (typeof localStorage === "undefined") return null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredReferral
    if (typeof parsed.code !== "string" || typeof parsed.savedAt !== "number") return null
    if (Date.now() - parsed.savedAt > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed.code
  } catch {
    return null
  }
}

export function clearStoredReferral(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(STORAGE_KEY)
}

function writeStoredReferral(code: string): void {
  if (typeof localStorage === "undefined") return
  const value: StoredReferral = { code: code.toUpperCase(), savedAt: Date.now() }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

export default function ReferralLandingRoute() {
  const params = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [status, setStatus] = createSignal<"checking" | "valid" | "invalid">("checking")
  const [bonus, setBonus] = createSignal<{ youDays: number; themDays: number } | null>(null)

  onMount(async () => {
    const raw = (params.code ?? "").trim().toUpperCase()
    if (!raw || !/^[A-Z0-9]{4,32}$/.test(raw)) {
      setStatus("invalid")
      return
    }
    // Optimistically stash the code. Even if the API is slow / down,
    // the signup form will pick it up and the server will validate
    // again at signup time — defence in depth.
    writeStoredReferral(raw)

    try {
      const res = await fetch(`${API_BASE}/account/me/resolve-referral?code=${encodeURIComponent(raw)}`, {
        method: "GET",
      })
      if (!res.ok) {
        setStatus("invalid")
        clearStoredReferral()
        return
      }
      const data = (await res.json()) as { valid: boolean; bonus_for_you?: number; bonus_for_them?: number }
      if (!data.valid) {
        setStatus("invalid")
        clearStoredReferral()
        return
      }
      setBonus({
        youDays: data.bonus_for_you ?? 0,
        themDays: data.bonus_for_them ?? 0,
      })
      setStatus("valid")
    } catch {
      // Network error — keep the code stashed (optimistic) and fall
      // through to a neutral "got a code, sign up to claim" copy
      // instead of a hard error.
      setStatus("valid")
    }
  })

  function continueToSignup() {
    navigate("/", { replace: true })
  }

  return (
    <div data-component="referral-landing" style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ "font-size": "48px", "margin-bottom": "12px" }}>🎁</div>
        <Show when={status() === "checking"}>
          <h1 style={titleStyle}>Verifying your invite…</h1>
          <p style={subtitleStyle}>Hold tight, we’re checking the referral code.</p>
        </Show>
        <Show when={status() === "valid"}>
          <h1 style={titleStyle}>You’ve been invited to CrimeCode!</h1>
          <p style={subtitleStyle}>
            <Show
              when={bonus()}
              fallback={<>Sign up with this link to claim your friend’s bonus.</>}
            >
              {(b) => (
                <>
                  Sign up with this link and get <strong>+{b().youDays} bonus trial days</strong>.<br />
                  Your friend earns <strong>+{b().themDays} days</strong> too — everyone wins.
                </>
              )}
            </Show>
          </p>
          <div style={codeBadgeStyle}>
            Code:&nbsp;<code style={{ "font-weight": 700 }}>{(params.code ?? "").toUpperCase()}</code>
          </div>
          <button type="button" onClick={continueToSignup} style={primaryButtonStyle}>
            Sign up &amp; claim bonus
          </button>
          <p style={hintStyle}>The code stays saved for 30 days. You can sign up later from any device.</p>
        </Show>
        <Show when={status() === "invalid"}>
          <h1 style={titleStyle}>Invite link invalid</h1>
          <p style={subtitleStyle}>
            That referral code doesn’t exist or has been removed. You can still sign up — just without the
            bonus.
          </p>
          <button type="button" onClick={continueToSignup} style={primaryButtonStyle}>
            Continue to sign up
          </button>
        </Show>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles — kept inline to avoid touching the global stylesheet for a single
// page. Matches the auth-gate's dark surface so the transition feels coherent.
// ---------------------------------------------------------------------------

const containerStyle: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "min-height": "100vh",
  padding: "24px",
  background: "linear-gradient(180deg, #0b0d11 0%, #11141a 100%)",
  color: "#e8eaed",
  "font-family": "system-ui, -apple-system, sans-serif",
}

const cardStyle: Record<string, string> = {
  width: "100%",
  "max-width": "480px",
  padding: "40px 32px",
  background: "#161a22",
  border: "1px solid #2a2f3a",
  "border-radius": "16px",
  "text-align": "center",
  "box-shadow": "0 20px 60px rgba(0, 0, 0, 0.45)",
}

const titleStyle: Record<string, string> = {
  margin: "0 0 12px",
  "font-size": "24px",
  "font-weight": "700",
  color: "#ffffff",
}

const subtitleStyle: Record<string, string> = {
  margin: "0 0 24px",
  "font-size": "15px",
  "line-height": "1.5",
  color: "#b1b6c0",
}

const codeBadgeStyle: Record<string, string> = {
  display: "inline-block",
  margin: "0 0 24px",
  padding: "8px 14px",
  background: "#0e1117",
  border: "1px dashed #3a4150",
  "border-radius": "8px",
  "font-family": "ui-monospace, monospace",
  "font-size": "14px",
  color: "#e8eaed",
}

const primaryButtonStyle: Record<string, string> = {
  display: "inline-block",
  padding: "12px 22px",
  background: "linear-gradient(180deg, #ff5a3d 0%, #d83b1f 100%)",
  color: "#fff",
  border: "none",
  "border-radius": "8px",
  "font-size": "15px",
  "font-weight": "600",
  cursor: "pointer",
  "min-width": "220px",
}

const hintStyle: Record<string, string> = {
  margin: "20px 0 0",
  "font-size": "12px",
  color: "#7a808d",
}
