import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import type { useFile } from "@/context/file"
import type { useLanguage } from "@/context/language"
import type { usePrompt } from "@/context/prompt"

/**
 * Shared context-menu actions for files. Used by both the editor tab
 * (session-sortable-tab.tsx) and the file tree (file-tree.tsx) so we
 * have one source of truth for what "copy path", "attach as context",
 * "reveal in explorer", etc. actually do.
 *
 * These helpers all assume:
 *   - desktop builds expose `window.api.openPath` and
 *     `window.api.showItemInFolder` (preload).
 *   - web builds (no Electron) gracefully degrade — copy still works
 *     (clipboard API), open-with-app falls back to a toast.
 */

const hasDesktopApi = (): boolean =>
  typeof (globalThis as unknown as { window?: { api?: { openPath?: unknown } } }).window?.api?.openPath === "function"

interface DesktopApi {
  openPath: (path: string, app?: string) => Promise<void>
  showItemInFolder: (path: string) => Promise<void>
}

const desktopApi = (): DesktopApi | null => {
  const api = (globalThis as unknown as { window?: { api?: DesktopApi } }).window?.api
  if (!api || typeof api.openPath !== "function") return null
  return api
}

/**
 * Write `text` to the system clipboard with a graceful fallback for
 * environments that don't expose `navigator.clipboard` (older Electron,
 * insecure contexts). Shows a toast describing what was copied; on
 * failure the toast is an error variant so the user isn't left guessing.
 */
export async function copyToClipboard(text: string, label: string, t: ReturnType<typeof useLanguage>["t"]): Promise<void> {
  const okMsg = t("common.copyToClipboard.success", { label }) || `${label} copied`
  const errMsg = t("common.copyToClipboard.error") || "Failed to copy"

  // 1) Modern API
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      showToast({ variant: "success", title: okMsg })
      return
    }
  } catch {
    /* fall through */
  }

  // 2) Legacy execCommand fallback (works in older Electron, insecure http)
  try {
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      ta.style.left = "-9999px"
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand("copy")
      document.body.removeChild(ta)
      showToast({ variant: "success", title: okMsg })
      return
    }
  } catch {
    /* fall through */
  }

  showToast({ variant: "error", title: errMsg })
}

/**
 * Resolve `relativeOrAbsolute` to an absolute filesystem path inside the
 * current SDK directory. The file tree exposes both `path` (relative to
 * worktree) and `absolute`, but the editor tab only knows the relative
 * one — so we need a helper that produces the absolute when given just
 * the relative.
 */
export function toAbsolute(file: ReturnType<typeof useFile>, sdkDirectory: string, p: string): string {
  // If it already looks absolute (starts with / on POSIX, or "X:" on Windows),
  // return unchanged.
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\")) return p
  // Otherwise join with worktree using the file context's normalize() to
  // strip any leading "./" / "/" so we don't end up with double-slashes.
  const rel = file.normalize(p)
  const sep = sdkDirectory.includes("\\") || /^[A-Za-z]:/.test(sdkDirectory) ? "\\" : "/"
  return sdkDirectory.replace(/[\\/]+$/, "") + sep + rel.replace(/[\\/]+/g, sep)
}

/** Compute the path relative to the workspace root. */
export function toRelative(file: ReturnType<typeof useFile>, p: string): string {
  return file.normalize(p)
}

/** Just the filename component, no directories. */
export function toFilename(p: string): string {
  return getFilename(p) || p.split(/[\\/]/).pop() || p
}

/**
 * Attach a file to the current chat composer's context list. The user
 * sees it appear in the "context chips" row above the prompt input.
 */
export function attachAsContext(prompt: ReturnType<typeof usePrompt>, relativePath: string): void {
  prompt.context.add({
    type: "file",
    path: relativePath,
  })
}

/**
 * Read the file content (load + read from cache) and copy it to clipboard.
 * Shows progress toasts so the user knows it's working for big files.
 */
export async function copyFileContent(
  file: ReturnType<typeof useFile>,
  relativePath: string,
  t: ReturnType<typeof useLanguage>["t"],
): Promise<void> {
  try {
    await file.load(relativePath)
    const state = file.get(relativePath)
    const content = state?.content?.content
    if (!content) {
      showToast({
        variant: "error",
        title: t("toast.file.loadFailed.title") || "Could not load file",
      })
      return
    }
    await copyToClipboard(content, t("editor.menu.fileContent") || "File content", t)
  } catch (err) {
    showToast({
      variant: "error",
      title: t("toast.file.loadFailed.title") || "Could not load file",
      description: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Open the file with its OS-default application (`shell.openPath` with
 * no app override). Useful as the "Edit / Open" entry — on most setups
 * this routes to the user's preferred editor for that file type.
 *
 * In a non-desktop (web) build this is a no-op + a toast so users know
 * why nothing happened.
 */
export async function openWithSystemDefault(
  absolutePath: string,
  t: ReturnType<typeof useLanguage>["t"],
): Promise<void> {
  const api = desktopApi()
  if (!api) {
    showToast({
      variant: "default",
      title: t("editor.menu.desktopOnly") || "Available only in the desktop app",
    })
    return
  }
  try {
    await api.openPath(absolutePath)
  } catch (err) {
    showToast({
      variant: "error",
      title: t("editor.menu.openFailed") || "Failed to open file",
      description: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Open with a specific external app (e.g. "code" for VS Code). On
 * Windows we try the executable name; on macOS we go through `open -a`
 * which is what the IPC handler does internally. Falls back to a toast
 * if the app isn't installed / not on PATH.
 */
export async function openWithApp(
  absolutePath: string,
  app: string,
  appLabel: string,
  t: ReturnType<typeof useLanguage>["t"],
): Promise<void> {
  const api = desktopApi()
  if (!api) {
    showToast({
      variant: "default",
      title: t("editor.menu.desktopOnly") || "Available only in the desktop app",
    })
    return
  }
  try {
    await api.openPath(absolutePath, app)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // ENOENT or "command not found" → friendly message about installing
    // the app. Anything else → surface the raw error so we don't lie.
    const friendly = /ENOENT|not found|recognized/i.test(msg)
      ? `${appLabel} is not installed or not on your PATH.`
      : msg
    showToast({
      variant: "error",
      title: t("editor.menu.openWithFailed", { app: appLabel }) || `Failed to open with ${appLabel}`,
      description: friendly,
    })
  }
}

/**
 * Reveal the file/folder in the OS file manager. On Windows this opens
 * Explorer with the item highlighted; on macOS it's Finder's "Reveal in
 * Finder"; on Linux it falls back to the default file manager.
 */
export async function revealInFileManager(
  absolutePath: string,
  t: ReturnType<typeof useLanguage>["t"],
): Promise<void> {
  const api = desktopApi()
  if (!api) {
    showToast({
      variant: "default",
      title: t("editor.menu.desktopOnly") || "Available only in the desktop app",
    })
    return
  }
  try {
    await api.showItemInFolder(absolutePath)
  } catch (err) {
    showToast({
      variant: "error",
      title: t("editor.menu.revealFailed") || "Failed to reveal in file manager",
      description: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Tells whether the desktop app is available — UI uses this to gate desktop-only items. */
export const isDesktop = (): boolean => hasDesktopApi()
