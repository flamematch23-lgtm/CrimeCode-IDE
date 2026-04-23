import { BrowserWindow, Menu, shell } from "electron"

import { ADMIN_PASSPHRASE_SHA256, CHANNEL, UPDATER_ENABLED } from "./constants"
import { createMainWindow } from "./windows"

type Deps = {
  trigger: (id: string) => void
  installCli: () => void
  checkForUpdates: () => void
  reload: () => void
  relaunch: () => void
}

const mac = process.platform === "darwin"

export function createMenu(deps: Deps) {
  const template: Electron.MenuItemConstructorOptions[] = []

  // macOS-only app submenu
  if (mac) {
    template.push({
      label: "OpenCode",
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          enabled: UPDATER_ENABLED,
          click: () => deps.checkForUpdates(),
        },
        {
          label: "Install CLI...",
          click: () => deps.installCli(),
        },
        { type: "separator" },
        { label: "Subscription...", click: () => deps.trigger("open-subscription") },
        {
          label: "Admin Panel...",
          visible: CHANNEL === "dev" || ADMIN_PASSPHRASE_SHA256.length > 0,
          click: () => deps.trigger("open-admin-panel"),
        },
        {
          label: "Reload Webview",
          click: () => deps.reload(),
        },
        {
          label: "Restart",
          click: () => deps.relaunch(),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    })
  }

  // File menu — on Windows/Linux includes app-level actions too
  const fileSub: Electron.MenuItemConstructorOptions[] = [
    { label: "New Session", accelerator: "Shift+CmdOrCtrl+S", click: () => deps.trigger("session.new") },
    { type: "separator" },
    { label: "New Project...", accelerator: "CmdOrCtrl+N", click: () => deps.trigger("project.new") },
    { label: "Open Project...", accelerator: "CmdOrCtrl+O", click: () => deps.trigger("project.open") },
    {
      label: "New Window",
      accelerator: "CmdOrCtrl+Shift+N",
      click: () => createMainWindow({ updaterEnabled: UPDATER_ENABLED }),
    },
    { type: "separator" },
    { label: "Account / Sign in...", click: () => deps.trigger("account.open") },
  ]

  if (!mac) {
    fileSub.push(
      { type: "separator" },
      {
        label: "Check for Updates...",
        enabled: UPDATER_ENABLED,
        click: () => deps.checkForUpdates(),
      },
      {
        label: "Install CLI...",
        click: () => deps.installCli(),
      },
      { type: "separator" },
      { label: "Subscription...", click: () => deps.trigger("open-subscription") },
      {
        label: "Admin Panel...",
        visible: CHANNEL === "dev" || ADMIN_PASSPHRASE_SHA256.length > 0,
        click: () => deps.trigger("open-admin-panel"),
      },
      {
        label: "Reload Webview",
        click: () => deps.reload(),
      },
      {
        label: "Restart",
        click: () => deps.relaunch(),
      },
      { type: "separator" },
      { role: "quit" },
    )
  } else {
    fileSub.push({ type: "separator" }, { role: "close" })
  }

  template.push({ label: "File", submenu: fileSub })

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  })

  template.push({
    label: "View",
    submenu: [
      { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: () => deps.trigger("sidebar.toggle") },
      { label: "Toggle Terminal", accelerator: "Ctrl+`", click: () => deps.trigger("terminal.toggle") },
      { label: "Toggle File Tree", click: () => deps.trigger("fileTree.toggle") },
      { type: "separator" },
      { label: "Back", click: () => deps.trigger("common.goBack") },
      { label: "Forward", click: () => deps.trigger("common.goForward") },
      { type: "separator" },
      {
        label: "Previous Session",
        accelerator: mac ? "Option+ArrowUp" : "Alt+Up",
        click: () => deps.trigger("session.previous"),
      },
      {
        label: "Next Session",
        accelerator: mac ? "Option+ArrowDown" : "Alt+Down",
        click: () => deps.trigger("session.next"),
      },
      { type: "separator" },
      {
        label: "Toggle Developer Tools",
        accelerator: mac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
        click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools(),
      },
    ],
  })

  template.push({
    label: "Help",
    submenu: [
      { label: "OpenCode Documentation", click: () => shell.openExternal("https://opencode.ai/docs") },
      { label: "Support Forum", click: () => shell.openExternal("https://discord.com/invite/opencode") },
      { type: "separator" },
      {
        label: "Share Feedback",
        click: () =>
          shell.openExternal("https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml"),
      },
      {
        label: "Report a Bug",
        click: () => shell.openExternal("https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml"),
      },
    ],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
