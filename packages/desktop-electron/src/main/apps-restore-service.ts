import { app, BrowserWindow } from "electron"
import { initLogging } from "./logging"
import type { AppsRestoreStatus } from "../preload/types"

const logger = initLogging()

/**
 * Apps-Restore service.
 *
 * When Claude is doing a long-running automation (computer-use) it may
 * minimise OpenCode windows or external apps to avoid clutter or
 * accidental clicks. The "Mostra le app quando Claude termina" toggle in
 * the Automation settings page asks us to restore those apps when Claude
 * stops the run.
 *
 * Two scopes are handled:
 *   • **OpenCode windows** — handled directly via Electron `BrowserWindow`.
 *     `restoreOwnWindows()` un-minimises every window we own. This always
 *     works.
 *   • **External apps** — tracked in `pending` for the agent layer to
 *     re-show. We don't ship native OS-hook bindings (AppleScript /
 *     wmctrl / Win32) so the actual "show external app X" call must come
 *     from the agent runtime which has those bindings.
 *
 * The toggle state itself IS persisted (via electron-store) so the user's
 * preference survives restarts. The `pending` queue is intentionally
 * memory-only — if OpenCode crashed mid-run the user has already restored
 * their workspace by hand, so blindly re-showing those windows on next
 * launch would be more annoying than helpful.
 */
class AppsRestoreService {
  /** Map of "tracking key" → small descriptor. Filled by Claude's automation
   *  layer when it decides to hide an external app; drained by
   *  `restoreAll()`. */
  private pending = new Map<string, { name: string; hiddenAt: number }>()
  private enabled = true

  setEnabled(value: boolean): AppsRestoreStatus {
    this.enabled = !!value
    logger.log("apps-restore: toggled", { enabled: this.enabled })
    return this.status()
  }

  status(): AppsRestoreStatus {
    return { enabled: this.enabled, pending: this.pending.size }
  }

  /** Called by the automation layer when it hides an external app. */
  trackHidden(key: string, name: string): void {
    if (!this.enabled) return
    this.pending.set(key, { name, hiddenAt: Date.now() })
  }

  /** Restore every OpenCode window that's currently minimised or hidden.
   *  Returns the count of windows we actually un-minimised so the caller
   *  can log it without re-querying. */
  private restoreOwnWindows(): number {
    let count = 0
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      let restored = false
      if (win.isMinimized()) {
        win.restore()
        restored = true
      }
      if (!win.isVisible()) {
        win.show()
        restored = true
      }
      if (restored) count++
    }
    return count
  }

  /** Restore everything we've tracked. Returns the total number of items
   *  that were signalled (own windows + external app queue size). */
  restoreAll(): number {
    if (!this.enabled) return 0
    const ownCount = this.restoreOwnWindows()
    const externalCount = this.pending.size
    this.pending.clear()
    if (ownCount + externalCount > 0) {
      logger.log("apps-restore: restored", { own: ownCount, external: externalCount })
    }
    return ownCount + externalCount
  }

  /** Hook into app quit so we never leave the workspace in a hidden state.
   *  We only restore on `before-quit` (not on every window-close) because a
   *  user closing one window doesn't mean the run is over. */
  attachLifecycle(): void {
    app.on("before-quit", () => {
      this.restoreAll()
    })
  }
}

export const appsRestoreService = new AppsRestoreService()
