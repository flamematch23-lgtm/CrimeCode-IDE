import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { hasAccountSession } from "@/utils/account-client"

const SEEN_KEY = "client.welcome.seen.v1"

interface Step {
  title: string
  body: string
  cta?: { label: string; href?: string; run?: () => void }
}

/**
 * Three-card first-run tour. Shown once (persisted in localStorage) the
 * first time the app boots. Skippable. Aimed at the lonely "new install"
 * state — most users see this for ~30 seconds total.
 */
export function WelcomeTour() {
  const [step, setStep] = createSignal<number | null>(null)
  const navigate = useNavigate()

  onMount(() => {
    try {
      if (localStorage.getItem(SEEN_KEY)) return
      // Don't show on top of a visible auth-gate — let the user sign in
      // first (or pick "use as guest"). We re-check after a short delay.
      const t = setTimeout(() => {
        try {
          if (localStorage.getItem(SEEN_KEY)) return
          setStep(0)
        } catch {
          /* ignore */
        }
      }, 2500)
      onCleanup(() => clearTimeout(t))
    } catch {
      /* ignore — private mode etc. */
    }
  })

  function done() {
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()))
    } catch {
      /* ignore */
    }
    setStep(null)
  }

  const steps = (): Step[] => {
    const signedIn = hasAccountSession()
    return [
      {
        title: "Welcome to CrimeCode 🔥",
        body:
          "An AI coding agent built for fraud research and security work. You can use it as a guest, or sign in with Telegram / username to get cross-device sync, license activation, and team workspaces.",
        cta: signedIn
          ? { label: "Continue", run: () => setStep(1) }
          : { label: "Sign in", run: () => {
              setStep(1)
              // Tell the workspace switcher to flash open — its own
              // login form lives in the popover.
              window.dispatchEvent(new CustomEvent("workspace-switcher-flash"))
            } },
      },
      {
        title: "Your trial is running",
        body:
          "All Pro features are unlocked while your trial is active. Open the Account dashboard any time to see how many days you have left, change your plan, or manage devices.",
        cta: { label: "Open Account", href: "/account" },
      },
      {
        title: "Try it now",
        body:
          "Open any project folder, then ask the agent to refactor a file, write a test, or explain what a function does. Press Cmd/Ctrl+K any time for the command palette.",
        cta: { label: "Got it", run: () => done() },
      },
    ]
  }

  return (
    <Show when={step() !== null}>
      <Portal>
        <div data-component="welcome-tour">
          <div data-slot="backdrop" onClick={() => done()} />
          <div data-slot="card" role="dialog" aria-label="Welcome tour">
            <button data-slot="skip" onClick={() => done()} aria-label="Skip tour">
              Skip
            </button>
            <Show when={steps()[step() ?? 0]}>
              {(s) => (
                <>
                  <h2>{s().title}</h2>
                  <p>{s().body}</p>
                  <div data-slot="dots">
                    {steps().map((_, i) => (
                      <span data-slot="dot" data-active={i === step()} />
                    ))}
                  </div>
                  <Show when={s().cta}>
                    {(cta) => (
                      <button
                        data-slot="cta"
                        onClick={() => {
                          const c = cta()
                          if (c.href) {
                            navigate(c.href)
                            done()
                          } else if (c.run) {
                            c.run()
                          }
                        }}
                      >
                        {cta().label}
                      </button>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
