import { systemPreferences } from "electron"
import { initLogging } from "./logging"
import type { ComputerUseStatus } from "../preload/types"

const logger = initLogging()

/**
 * Computer-Use master toggle.
 *
 * The renderer drives a single boolean ("Uso del computer (Beta)") via the
 * Automation settings page. This service is the source of truth in the main
 * process: it persists the runtime flag, validates that the OS allows
 * screen + accessibility access, and exposes a tiny status object so the UI
 * can show *why* activation failed when it does.
 *
 * This file deliberately does NOT implement keyboard/mouse synthesis or
 * screen capture — those live in the agent's tool layer. We only own the
 * permission gate, because:
 *   1. macOS requires the Accessibility / Screen-Recording prompts to be
 *      triggered from the main process (renderer can't request them).
 *   2. Wayland on Linux silently ignores synthetic input, so there's no
 *      point in lighting up the toggle there.
 *   3. Sandbox-style flatpak/snap installs can revoke the capability at
 *      any time, and the renderer should reflect that.
 */
class ComputerUseService {
  private enabled = false

  status(): ComputerUseStatus {
    if (this.enabled) return { enabled: true }
    const reason = this.platformReason()
    if (reason) return { enabled: false, reason }
    return { enabled: false, reason: "not-activated" }
  }

  /** Activate or deactivate. Returns the effective status, which may differ
   *  from the requested value if the OS denied the permission. */
  async setEnabled(value: boolean): Promise<ComputerUseStatus> {
    if (!value) {
      this.enabled = false
      logger.log("computer-use: deactivated by user")
      return { enabled: false, reason: "not-activated" }
    }

    const platformReason = this.platformReason()
    if (platformReason) {
      this.enabled = false
      logger.log("computer-use: activation refused", { reason: platformReason })
      return { enabled: false, reason: platformReason }
    }

    // macOS gates: ensure both Screen Recording and Accessibility are
    // granted before flipping the flag, otherwise Claude would silently
    // produce blank screenshots / dropped clicks.
    if (process.platform === "darwin") {
      const screen = systemPreferences.getMediaAccessStatus("screen")
      if (screen !== "granted") {
        // ask() not available for "screen"; trigger the OS prompt by attempting
        // a desktopCapturer access — the user has to grant from System Settings.
        logger.log("computer-use: macOS screen access not granted", { screen })
        this.enabled = false
        return { enabled: false, reason: "permission-denied" }
      }
      const accessibility = systemPreferences.isTrustedAccessibilityClient(true)
      if (!accessibility) {
        logger.log("computer-use: macOS accessibility not granted")
        this.enabled = false
        return { enabled: false, reason: "permission-denied" }
      }
    }

    this.enabled = true
    logger.log("computer-use: activated")
    return { enabled: true }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Returns a `reason` if the current OS/session does not support the
   *  feature, regardless of the user's preference. */
  private platformReason(): ComputerUseStatus["reason"] | null {
    // Wayland (and X11 with input grabbing disabled) cannot reliably synthesise
    // input via Electron's underlying APIs. Detect via session type.
    if (process.platform === "linux") {
      const session = process.env.XDG_SESSION_TYPE
      if (session === "wayland") return "platform-unsupported"
    }
    return null
  }
}

export const computerUseService = new ComputerUseService()
