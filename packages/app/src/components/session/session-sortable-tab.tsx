import { createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { getFilename } from "@opencode-ai/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import {
  attachAsContext,
  copyFileContent,
  copyToClipboard,
  isDesktop,
  openWithApp,
  openWithSystemDefault,
  revealInFileManager,
  toAbsolute,
  toFilename,
  toRelative,
} from "@/components/file-actions"

export function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{getFilename(props.path)}</span>
    </div>
  )
}

export function SortableTab(props: { tab: string; onTabClose: (tab: string) => void }): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const prompt = usePrompt()
  const sdk = useSDK()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} />
  })

  // Right-click handlers — all guarded against `path()` being undefined
  // (which only happens for very transient states like a tab being closed
  // while the menu is still open). The handlers all run in the SDK
  // directory scope so absolute paths are produced correctly.
  const onAttach = () => {
    const p = path()
    if (!p) return
    attachAsContext(prompt, file.normalize(p))
  }
  const onCopyContent = () => {
    const p = path()
    if (!p) return
    void copyFileContent(file, p, language.t)
  }
  const onCopyAbsolute = () => {
    const p = path()
    if (!p) return
    const abs = toAbsolute(file, sdk.directory, p)
    void copyToClipboard(abs, language.t("editor.menu.path"), language.t)
  }
  const onCopyRelative = () => {
    const p = path()
    if (!p) return
    void copyToClipboard(toRelative(file, p), language.t("editor.menu.relativePath"), language.t)
  }
  const onCopyName = () => {
    const p = path()
    if (!p) return
    void copyToClipboard(toFilename(p), language.t("editor.menu.fileName"), language.t)
  }
  const onEdit = () => {
    const p = path()
    if (!p) return
    void openWithSystemDefault(toAbsolute(file, sdk.directory, p), language.t)
  }
  const onOpenInVSCode = () => {
    const p = path()
    if (!p) return
    void openWithApp(toAbsolute(file, sdk.directory, p), "code", "VS Code", language.t)
  }
  const onReveal = () => {
    const p = path()
    if (!p) return
    void revealInFileManager(toAbsolute(file, sdk.directory, p), language.t)
  }

  return (
    <ContextMenu>
      <ContextMenu.Trigger>
        <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
          <div class="relative">
            <Tabs.Trigger
              value={props.tab}
              closeButton={
                <TooltipKeybind
                  title={language.t("common.closeTab")}
                  keybind={command.keybind("tab.close")}
                  placement="bottom"
                  gutter={10}
                >
                  <IconButton
                    icon="close-small"
                    variant="ghost"
                    class="h-5 w-5"
                    onClick={() => props.onTabClose(props.tab)}
                    aria-label={language.t("common.closeTab")}
                  />
                </TooltipKeybind>
              }
              hideCloseButton
              onMiddleClick={() => props.onTabClose(props.tab)}
            >
              <Show when={content()}>{(value) => value()}</Show>
            </Tabs.Trigger>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={onEdit}>
            <ContextMenu.ItemLabel>{language.t("common.edit")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={onAttach}>
            <ContextMenu.ItemLabel>{language.t("editor.menu.attachAsContext")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={onCopyContent}>
            <ContextMenu.ItemLabel>{language.t("editor.menu.copyContent")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={onCopyAbsolute}>
            <ContextMenu.ItemLabel>{language.t("editor.menu.copyPath")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <Show when={isDesktop()}>
            <ContextMenu.Separator />
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger>{language.t("editor.menu.openIn")}</ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent>
                  <ContextMenu.Item onSelect={onOpenInVSCode}>
                    <ContextMenu.ItemLabel>{language.t("editor.menu.openInVSCode")}</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item onSelect={onReveal}>
                    <ContextMenu.ItemLabel>{language.t("editor.menu.openInExplorer")}</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}
