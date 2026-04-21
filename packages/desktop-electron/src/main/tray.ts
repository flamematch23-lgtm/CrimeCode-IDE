import { app, BrowserWindow, globalShortcut, Menu, Tray } from "electron"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { UPDATER_ENABLED } from "./constants"

const root = dirname(fileURLToPath(import.meta.url))

let tray: Tray | null = null
let enabled = false

type Deps = {
  win: () => BrowserWindow | null
  checkForUpdates: () => void
  newSession: () => void
  quit: () => void
}

function icon() {
  const dir = app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(dir, `icon.${ext}`)
}

function toggle(win: BrowserWindow | null) {
  if (!win) return
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

export function isTrayEnabled() {
  return enabled
}

export function createTray(deps: Deps) {
  if (tray) return

  tray = new Tray(icon())
  enabled = true

  const menu = Menu.buildFromTemplate([
    {
      label: "Show / Hide",
      click: () => toggle(deps.win()),
    },
    {
      label: "New Session",
      click: () => deps.newSession(),
    },
    { type: "separator" },
    {
      label: "Always on Top",
      type: "checkbox",
      checked: deps.win()?.isAlwaysOnTop() ?? false,
      click: (item) => {
        const win = deps.win()
        if (win) win.setAlwaysOnTop(item.checked)
      },
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: true,
        })
      },
    },
    { type: "separator" },
    {
      label: "Check for Updates...",
      enabled: UPDATER_ENABLED,
      click: () => deps.checkForUpdates(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => deps.quit(),
    },
  ])

  tray.setToolTip("OpenCode")
  tray.setContextMenu(menu)

  tray.on("click", () => toggle(deps.win()))

  // Global shortcut: Ctrl+Shift+O to toggle window
  globalShortcut.register("CommandOrControl+Shift+O", () => toggle(deps.win()))

  app.on("will-quit", () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
    enabled = false
  })
}
