import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { sampledChecksum } from "@opencode-ai/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@opencode-ai/ui/toast"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"

function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

export function FileTabContent(props: { tab: string }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const fileComponent = useFileComponent()
  const { sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: { x: number; y: number } | undefined
  let codeScroll: HTMLElement[] = []
  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")

  // Defensively kick off a load whenever the active path changes.
  // Without this, switching to a tab that was opened in a previous
  // session (rehydrated from localStorage) shows an empty viewer
  // because nothing else triggers `file.load(path)` for it.
  // `load` is idempotent — it short-circuits if already loaded.
  createEffect(() => {
    const p = path()
    if (!p) return
    void file.load(p)
  })
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview =
      input.preview ??
      (() => {
        if (input.file === path()) return selectionPreview(contents(), selection)
        const source = file.get(input.file)?.content?.content
        if (!source) return undefined
        return selectionPreview(source, selection)
      })()

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview =
      input.file === path() ? selectionPreview(contents(), selectionFromLines(input.selection)) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeFileTab() !== props.tab) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })

  createEffect(
    on(
      path,
      () => {
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  const getCodeScroll = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const queueScrollUpdate = (next: { x: number; y: number }) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      view().setScroll(props.tab, out)
    })
  }

  const handleCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    queueScrollUpdate({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const syncCodeScroll = () => {
    const next = getCodeScroll()
    if (next.length === codeScroll.length && next.every((el, i) => el === codeScroll[i])) return

    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    codeScroll = next

    for (const item of codeScroll) {
      item.addEventListener("scroll", handleCodeScroll)
    }
  }

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll(props.tab)
    if (!s) return

    syncCodeScroll()

    if (codeScroll.length > 0) {
      for (const item of codeScroll) {
        if (item.scrollLeft !== s.x) item.scrollLeft = s.x
      }
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (codeScroll.length > 0) return
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restoreScroll()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (codeScroll.length === 0) syncCodeScroll()

    queueScrollUpdate({
      x: codeScroll[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  const cancelCommenting = () => {
    const p = path()
    if (p) file.setSelectedLines(p, null)
    setNote("commenting", null)
  }

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    queueRestore()
  })

  onCleanup(() => {
    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  // Edit mode: toggled via the "Modifica" button in the file viewer toolbar.
  // Shows a textarea with the current content, Save persists via file.save()
  // (which hits PUT /file/content on the sidecar), Cancel discards.
  // Read-only / no-editor when:
  //   - sdk has no base url (web build pointing at a server that doesn't
  //     expose /file/content)
  //   - the file is binary (state.content.type === "binary")
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const canEdit = createMemo(() => {
    const s = state()
    if (!s?.loaded) return false
    if (s.content?.type !== "text") return false
    if (s.content?.encoding === "base64") return false // image / binary served as text
    return true
  })

  function startEditing() {
    setDraft(contents())
    setEditing(true)
  }
  function cancelEditing() {
    setEditing(false)
    setDraft("")
  }
  async function saveEditing() {
    const p = path()
    if (!p) return
    setSaving(true)
    try {
      await file.save(p, draft())
      showToast({ variant: "success", title: language.t("editor.save.success") || "File saved" })
      setEditing(false)
      setDraft("")
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("editor.save.failed") || "Save failed",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSaving(false)
    }
  }

  const renderEditor = () => (
    <div class="relative h-full flex flex-col">
      <div class="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-surface-raised-base border-b border-border-base">
        <span class="text-12-medium text-text-strong">
          {language.t("editor.editing") || "Editing"} {path() ?? ""}
        </span>
        <span class="flex-1" />
        <button
          type="button"
          class="px-3 py-1 text-12-medium rounded border border-border-base bg-surface-base text-text-strong hover:bg-surface-base-hover disabled:opacity-50"
          onClick={cancelEditing}
          disabled={saving()}
        >
          {language.t("common.cancel") || "Cancel"}
        </button>
        <button
          type="button"
          class="px-3 py-1 text-12-medium rounded bg-icon-action-base text-white hover:bg-icon-action-strong disabled:opacity-50"
          onClick={() => void saveEditing()}
          disabled={saving() || draft() === contents()}
        >
          {saving() ? language.t("common.saving") || "Saving…" : language.t("common.save") || "Save"}
        </button>
      </div>
      <textarea
        class="flex-1 w-full px-4 py-3 bg-background-base text-text-strong font-mono text-13-regular outline-none resize-none"
        spellcheck={false}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Ctrl/Cmd+S to save without leaving the textarea.
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault()
            void saveEditing()
          }
          if (e.key === "Escape") {
            e.preventDefault()
            cancelEditing()
          }
        }}
      />
    </div>
  )

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Show when={canEdit()}>
        <div class="sticky top-0 z-10 flex justify-end px-4 py-2 bg-background-base/80 backdrop-blur-sm">
          <button
            type="button"
            class="px-3 py-1 text-12-medium rounded border border-border-base bg-surface-raised-base text-text-strong hover:bg-surface-raised-base-hover"
            onClick={startEditing}
          >
            ✏️ {language.t("common.edit") || "Edit"}
          </button>
        </div>
      </Show>
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        enableHoverUtility
        selectedLines={activeSelection()}
        commentedLines={commentedLines()}
        onRendered={() => {
          queueRestore()
        }}
        annotations={commentsUi.annotations()}
        renderAnnotation={commentsUi.renderAnnotation}
        renderHoverUtility={commentsUi.renderHoverUtility}
        onLineSelected={(range: SelectedLineRange | null) => {
          commentsUi.onLineSelected(range)
        }}
        onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
        onLineSelectionEnd={(range: SelectedLineRange | null) => {
          commentsUi.onLineSelectionEnd(range)
        }}
        search={search}
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: queueRestore,
          onError: (args: { kind: "image" | "audio" | "svg" }) => {
            if (args.kind !== "svg") return
            showToast({
              variant: "error",
              title: language.t("toast.file.loadFailed.title"),
            })
          },
        }}
      />
    </div>
  )

  return (
    <Tabs.Content value={props.tab} class="mt-3 relative h-full">
      <ScrollView
        class="h-full"
        viewportRef={(el: HTMLDivElement) => {
          scroll = el
          restoreScroll()
        }}
        onScroll={handleScroll as any}
      >
        <Switch>
          <Match when={editing()}>{renderEditor()}</Match>
          <Match when={state()?.loaded}>{renderFile(contents())}</Match>
          <Match when={state()?.loading}>
            <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
          </Match>
          <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
          {/* Fallback for the brief window between tab open + load resolution,
             AND for tabs that somehow ended up without a load triggered. The
             createEffect above guarantees we *will* load — this just keeps
             the panel from rendering blank. */}
          <Match when={!state() || (!state()?.loaded && !state()?.loading && !state()?.error)}>
            <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
          </Match>
        </Switch>
      </ScrollView>
    </Tabs.Content>
  )
}
