import fs from "fs"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

/**
 * Automation runtime state shared between the desktop main process (Electron)
 * and the opencode sidecar.
 *
 * The desktop "Settings → Automation" panel persists each toggle to
 * electron-store, **and** mirrors it into a small JSON file at
 * `{Global.Path.state}/automation.json`. The sidecar reads that file on every
 * tool invocation that needs to honour an automation toggle:
 *
 *  - `browserAllowAll` — when false, the `browser` tool calls `ctx.ask()`
 *    before each action so the user can approve/deny per-call.
 *  - `computerUseEnabled` — when false, tools that perform native input or
 *    screen capture (screenshot, future mouse/keyboard tools) refuse to run.
 *  - `restoreAppsOnExit` — read by the desktop main process directly; not
 *    consumed here, but kept in the file so the sidecar has a complete view.
 *
 * Env-var fallbacks (`OPENCODE_AUTOMATION_*`) are honoured too — useful for
 * headless CI runs and for backward-compat with older desktop builds that
 * only set env vars at sidecar spawn.
 *
 * The reader is deliberately synchronous + filesystem-backed (no IPC, no
 * watcher): every read is cheap (~20 µs), and toggling a switch should take
 * effect on the very next tool call without restarting the sidecar.
 */
export namespace Automation {
  const log = Log.create({ service: "automation" })

  const FILE_NAME = "automation.json"

  export type State = {
    browserAllowAll: boolean
    computerUseEnabled: boolean
    restoreAppsOnExit: boolean
  }

  const DEFAULT_STATE: State = {
    browserAllowAll: false,
    computerUseEnabled: false,
    restoreAppsOnExit: true,
  }

  function statePath() {
    return path.join(Global.Path.state, FILE_NAME)
  }

  function envBool(name: string): boolean | undefined {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return undefined
    if (raw === "1" || raw.toLowerCase() === "true") return true
    if (raw === "0" || raw.toLowerCase() === "false") return false
    return undefined
  }

  function readFile(): Partial<State> {
    try {
      const raw = fs.readFileSync(statePath(), "utf8")
      const parsed = JSON.parse(raw) as Partial<State>
      if (parsed && typeof parsed === "object") return parsed
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log.warn("failed to read automation state", { error: err?.message })
      }
    }
    return {}
  }

  /** Snapshot of the current automation state. */
  export function read(): State {
    const fileState = readFile()
    return {
      browserAllowAll:
        envBool("OPENCODE_AUTOMATION_BROWSER_ALLOW_ALL") ??
        fileState.browserAllowAll ??
        DEFAULT_STATE.browserAllowAll,
      computerUseEnabled:
        envBool("OPENCODE_AUTOMATION_COMPUTER_USE") ??
        fileState.computerUseEnabled ??
        DEFAULT_STATE.computerUseEnabled,
      restoreAppsOnExit:
        envBool("OPENCODE_AUTOMATION_RESTORE_APPS") ??
        fileState.restoreAppsOnExit ??
        DEFAULT_STATE.restoreAppsOnExit,
    }
  }

  /** Convenience accessor: skip per-action permission prompts for browser tool. */
  export function browserAllowAll(): boolean {
    return read().browserAllowAll
  }

  /** Convenience accessor: computer-use master toggle. */
  export function computerUseEnabled(): boolean {
    return read().computerUseEnabled
  }

  /**
   * Persist new state to disk. Called from the sidecar only when the user has
   * no desktop running (CLI workflows). On desktop the Electron main process
   * owns the file and the sidecar treats it as read-only.
   */
  export function write(partial: Partial<State>): State {
    const current = read()
    const next: State = { ...current, ...partial }
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true })
      fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8")
    } catch (err: any) {
      log.error("failed to persist automation state", { error: err?.message })
    }
    return next
  }
}
