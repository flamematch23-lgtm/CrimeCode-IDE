/**
 * DialogBuilder — "What do you want to build?" composer.
 *
 * Visual design inspired by blink.new — sticky composer feel inside a
 * roomy modal: tab pills on top, generous textarea, bottom toolbar with
 * "+ attach", custom model picker (tier badges), Agent toggle, mic icon
 * (placeholder), and a circular submit button. Suggested chips below
 * with the tab's icon prepended.
 *
 * Triggered by the "+" / "New session" button in the workspace sidebar
 * (sidebar-workspace.tsx).
 *
 * On Run:
 *   - Creates a new session via globalSDK.client.session.create()
 *   - Stores `{ sessionId, prompt, model, agent, system }` in
 *     localStorage under `builder.pending` so the session page can
 *     pre-fill the composer + auto-submit on first mount (handoff
 *     wiring in pages/session/* TODO — without it the user lands on a
 *     blank session and the prompt is preserved in localStorage)
 *   - Navigates to /<slug>/session/<id>
 */

import { Component, createMemo, createResource, createSignal, For, Show, Switch, Match, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useGlobalSDK } from "@/context/global-sdk"
import { setSessionHandoff } from "@/pages/session/handoff"
import type { Prompt } from "@/context/prompt"
import {
  agentNameForTab,
  fetchBuilderTemplates,
  systemPromptForTab,
  type BuilderTab,
  type BuilderTemplate,
} from "@/utils/builder-client"

const TABS: { id: BuilderTab; icon: string }[] = [
  { id: "pentest", icon: "shield" },
  { id: "exploit", icon: "code-lines" },
  { id: "osint", icon: "magnifying-glass" },
  { id: "webapp", icon: "code" },
  { id: "api", icon: "server" },
  { id: "mobile", icon: "models" },
]

interface ModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  tier: "max" | "pro" | "free"
}

function classifyTier(input: number, providerId: string, modelId: string): "max" | "pro" | "free" {
  if (input <= 0) return "free"
  const isMax =
    /opus/i.test(modelId) ||
    providerId === "claude-code" ||
    /^gpt-5(?!-mini|-nano)/i.test(modelId) ||
    /gemini-3-pro/i.test(modelId)
  return isMax ? "max" : "pro"
}

const TIER_STYLES = {
  max: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  pro: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  free: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
}

export interface DialogBuilderProps {
  workspaceDirectory: string
}

export const DialogBuilder: Component<DialogBuilderProps> = (props) => {
  const dialog = useDialog()
  const navigate = useNavigate()
  const language = useLanguage()
  const providers = useProviders()
  const globalSDK = useGlobalSDK()

  const [activeTab, setActiveTab] = createSignal<BuilderTab>("webapp")
  const [prompt, setPrompt] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
  const [agentOn, setAgentOn] = createSignal(true)

  // Build model options from real connected providers.
  const modelOptions = createMemo<ModelOption[]>(() => {
    const out: ModelOption[] = []
    for (const p of providers.connected()) {
      for (const m of Object.values(p.models)) {
        if (m.status === "deprecated") continue
        out.push({
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          modelName: m.name ?? m.id,
          tier: classifyTier(m.cost?.input ?? 0, p.id, m.id),
        })
      }
    }
    const tierWeight = { max: 0, pro: 1, free: 2 } as const
    out.sort((a, b) => {
      if (a.tier !== b.tier) return tierWeight[a.tier] - tierWeight[b.tier]
      return a.modelName.localeCompare(b.modelName)
    })
    return out
  })

  const [selectedModelKey, setSelectedModelKey] = createSignal<string | null>(null)
  const selectedModel = createMemo(() => {
    const key = selectedModelKey()
    const list = modelOptions()
    if (key) {
      const found = list.find((o) => `${o.providerId}/${o.modelId}` === key)
      if (found) return found
    }
    return list[0]
  })

  const [refreshKey, setRefreshKey] = createSignal(0)
  const [suggestions] = createResource(
    () => ({ tab: activeTab(), key: refreshKey() }),
    async (input) => fetchBuilderTemplates(input.tab, 4),
  )

  const placeholder = createMemo(() => language.t(`builder.placeholder.${activeTab()}` as any))

  const pickSuggestion = (s: BuilderTemplate) => setPrompt(s.prompt_seed)

  const handleRun = async () => {
    const text = prompt().trim()
    if (!text) {
      showToast({ variant: "error", title: language.t("builder.empty.prompt") })
      return
    }
    const model = selectedModel()
    if (!model) {
      showToast({ variant: "error", title: language.t("builder.error.noModel") })
      return
    }
    setSubmitting(true)
    try {
      const created = await globalSDK.client.session.create().then((x) => x.data)
      if (!created) {
        showToast({
          variant: "error",
          title: language.t("builder.error.sessionCreate", { error: "no data" }),
        })
        return
      }

      // Build the Prompt parts the composer will pre-fill: agent mention
      // (if Agent toggle on) + a small "[Builder system prompt]" prefix
      // + the user's text. The system prompt prefix tells the agent which
      // persona to adopt for this engagement (pentest/exploit/osint/etc.).
      const dirSlug = base64Encode(props.workspaceDirectory)
      const sessionKey = `${dirSlug}/${created.id}`
      const tab = activeTab()
      const agentName = agentOn() ? agentNameForTab(tab) : null
      const systemPrefix = `[${tab.toUpperCase()} engagement]\n${systemPromptForTab(tab)}\n\n---\n\n`
      const fullText = systemPrefix + text

      const parts: Prompt = []
      let cursor = 0
      if (agentName) {
        const mention = `@${agentName}`
        parts.push({ type: "agent", name: agentName, content: mention, start: cursor, end: cursor + mention.length })
        cursor += mention.length
        const sep = " "
        parts.push({ type: "text", content: sep, start: cursor, end: cursor + sep.length })
        cursor += sep.length
      }
      parts.push({ type: "text", content: fullText, start: cursor, end: cursor + fullText.length })

      // Hand off via the existing handoff store. The composer at
      // session-composer-region.tsx consumes pendingPrompt on first ready
      // and (if autoSubmit:true) immediately fires a real form submit.
      setSessionHandoff(sessionKey, { pendingPrompt: parts, autoSubmit: true })

      // Note about model selection: setting `selectedModel` mid-flight
      // requires plumbing into the composer's currentModel signal which
      // varies per harness. For now we let the composer use the user's
      // last-selected model. A proper "force model X for this session"
      // path is TODO — track in providerId/modelId from this builder.
      void model.providerId
      void model.modelId

      dialog.close()
      navigate(`/${dirSlug}/session/${created.id}`)
    } catch (e) {
      showToast({
        variant: "error",
        title: language.t("builder.error.sessionCreate", {
          error: (e as Error).message ?? String(e).slice(0, 100),
        }),
      })
    } finally {
      setSubmitting(false)
    }
  }

  // Close model picker on outside click + escape.
  let pickerRef: HTMLDivElement | undefined
  const onDocClick = (e: MouseEvent) => {
    if (modelPickerOpen() && pickerRef && !pickerRef.contains(e.target as Node)) {
      setModelPickerOpen(false)
    }
  }
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && modelPickerOpen()) setModelPickerOpen(false)
  }
  onMount(() => {
    document.addEventListener("click", onDocClick)
    document.addEventListener("keydown", onEsc)
  })
  onCleanup(() => {
    document.removeEventListener("click", onDocClick)
    document.removeEventListener("keydown", onEsc)
  })

  return (
    <Dialog title={language.t("builder.title")} transition>
      <div class="flex flex-col gap-5 px-2.5 pb-4 w-[820px] max-w-[92vw] relative">
        {/* Subtle radial glow background, blink-style */}
        <div
          class="absolute inset-0 -z-10 pointer-events-none opacity-60"
          style={{
            background:
              "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 60%)",
          }}
        />

        <div class="text-13-regular text-text-weak px-2.5">{language.t("builder.subtitle")}</div>

        {/* Tab pills — modern card-style with active glow */}
        <div class="flex gap-1.5 px-2.5 overflow-x-auto pb-1">
          <For each={TABS}>
            {(t) => (
              <button
                onClick={() => setActiveTab(t.id)}
                class="px-3 py-1.5 rounded-md text-12-regular flex items-center gap-1.5 border whitespace-nowrap transition-all"
                classList={{
                  "bg-surface-base border-border-base text-text-strong shadow-sm": activeTab() === t.id,
                  "bg-transparent border-transparent text-text-weak hover:text-text-base hover:bg-surface-weak/30":
                    activeTab() !== t.id,
                }}
              >
                <Icon name={t.icon as any} class="size-3.5" />
                {language.t(`builder.tab.${t.id}` as any)}
              </button>
            )}
          </For>
        </div>

        {/* Composer card — generous, dark, with bottom toolbar inside */}
        <div class="mx-2.5 rounded-xl bg-surface-weak/40 border border-border-base/60 overflow-hidden flex flex-col">
          <textarea
            class="w-full min-h-[140px] max-h-[280px] resize-y bg-transparent border-0 px-4 py-3.5 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none"
            placeholder={placeholder()}
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                void handleRun()
              }
            }}
            disabled={submitting()}
          />

          {/* Bottom toolbar — all icons + custom model picker */}
          <div class="flex items-center gap-1.5 px-2 py-2 border-t border-border-base/40 bg-surface-base/30">
            {/* + attach (placeholder) */}
            <button
              type="button"
              class="p-1.5 rounded-md text-text-weak hover:text-text-base hover:bg-surface-weak/40 transition-colors"
              title={language.t("builder.toolbar.attach")}
              aria-label={language.t("builder.toolbar.attach")}
              disabled
            >
              <Icon name="plus" class="size-4" />
            </button>

            {/* Custom model picker */}
            <div class="relative" ref={pickerRef}>
              <Show
                when={modelOptions().length > 0}
                fallback={
                  <span class="px-2 py-1 text-12-regular text-icon-warning-base">
                    {language.t("builder.error.noModel")}
                  </span>
                }
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setModelPickerOpen(!modelPickerOpen())
                  }}
                  class="px-2 py-1 rounded-md text-12-regular text-text-base hover:bg-surface-weak/40 transition-colors flex items-center gap-1.5 border border-transparent hover:border-border-base/40"
                  disabled={submitting()}
                >
                  <Icon name="brain" class="size-3.5 text-text-weak" />
                  <span class="font-medium">{selectedModel()?.modelName ?? "Model"}</span>
                  <span
                    class={`text-10-regular px-1.5 py-0.5 rounded border ${
                      TIER_STYLES[selectedModel()?.tier ?? "free"]
                    }`}
                  >
                    {language.t(`builder.model.tier.${selectedModel()?.tier ?? "free"}` as any)}
                  </span>
                  <Icon name="chevron-down" class="size-3 text-text-weak" />
                </button>
                <Show when={modelPickerOpen()}>
                  <div class="absolute bottom-full left-0 mb-1 z-50 min-w-[280px] max-h-[320px] overflow-y-auto bg-surface-base border border-border-base rounded-md shadow-lg p-1">
                    <For each={modelOptions()}>
                      {(m) => {
                        const key = `${m.providerId}/${m.modelId}`
                        const isCurrent = selectedModel() && `${selectedModel()!.providerId}/${selectedModel()!.modelId}` === key
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedModelKey(key)
                              setModelPickerOpen(false)
                            }}
                            class="w-full text-left px-2 py-1.5 rounded text-12-regular flex items-center gap-2 hover:bg-surface-raised-base-hover transition-colors"
                            classList={{ "bg-surface-weak/40": !!isCurrent }}
                          >
                            <Icon name="brain" class="size-3.5 text-text-weak shrink-0" />
                            <span class="flex-1 truncate text-text-strong">{m.modelName}</span>
                            <span class="text-11-regular text-text-weak truncate max-w-[90px]">
                              {m.providerName}
                            </span>
                            <span
                              class={`text-10-regular px-1.5 py-0.5 rounded border shrink-0 ${TIER_STYLES[m.tier]}`}
                            >
                              {language.t(`builder.model.tier.${m.tier}` as any)}
                            </span>
                            <Show when={isCurrent}>
                              <Icon name="check" class="size-3.5 text-icon-success-base shrink-0" />
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>

            <div class="flex-1" />

            {/* Agent toggle */}
            <button
              type="button"
              onClick={() => setAgentOn(!agentOn())}
              class="px-2 py-1 rounded-md text-12-regular flex items-center gap-1.5 border transition-colors"
              classList={{
                "bg-emerald-500/15 text-emerald-300 border-emerald-500/30": agentOn(),
                "bg-transparent text-text-weak border-transparent hover:text-text-base hover:bg-surface-weak/40":
                  !agentOn(),
              }}
              title={language.t("builder.toolbar.agent")}
            >
              <Icon name="brain" class="size-3.5" />
              {language.t("builder.toolbar.agent")}
            </button>

            {/* Mic (placeholder, not wired to STT) */}
            <button
              type="button"
              class="p-1.5 rounded-md text-text-weak hover:text-text-base hover:bg-surface-weak/40 transition-colors"
              title={language.t("builder.toolbar.mic")}
              aria-label={language.t("builder.toolbar.mic")}
              disabled
            >
              <Icon name="speech-bubble" class="size-4" />
            </button>

            {/* Submit circle button — blink style */}
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={!prompt().trim() || submitting() || modelOptions().length === 0}
              class="size-8 rounded-full bg-blue-500 hover:bg-blue-400 disabled:bg-surface-weak/50 disabled:text-text-weak text-white flex items-center justify-center transition-colors shrink-0"
              title={language.t("builder.toolbar.submit")}
              aria-label={language.t("builder.toolbar.submit")}
            >
              <Show when={!submitting()} fallback={<span class="text-10-regular">…</span>}>
                <Icon name="arrow-up" class="size-4" />
              </Show>
            </button>
          </div>
        </div>

        {/* Empty-state hints — show only when prompt is empty, blink-style
            "Clone any website with just a URL" */}
        <Show when={!prompt().trim() && (suggestions()?.length ?? 0) === 0}>
          <div class="px-5 flex flex-col gap-2">
            <For each={[
              { icon: "link", key: "builder.hint.cloneUrl" },
              { icon: "brain", key: "builder.hint.addAi" },
              { icon: "shield", key: "builder.hint.addAuth" },
              { icon: "server", key: "builder.hint.addDb" },
            ]}>
              {(h) => (
                <div class="flex items-center gap-2 text-12-regular text-text-weak">
                  <Icon name={h.icon as any} class="size-3.5" />
                  <span>{language.t(h.key as any)}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Suggestions chips — blink-style, with tab icon prepended */}
        <Show when={(suggestions()?.length ?? 0) > 0 || suggestions.loading}>
          <div class="px-2.5 flex flex-col gap-2">
            <Switch>
              <Match when={suggestions.loading}>
                <span class="text-12-regular text-text-weak px-1">
                  {language.t("builder.suggestions.loading")}
                </span>
              </Match>
              <Match when={(suggestions()?.length ?? 0) > 0}>
                <div class="flex flex-wrap gap-2 items-center">
                  <For each={suggestions()}>
                    {(s) => {
                      const tab = TABS.find((t) => t.id === activeTab())!
                      return (
                        <button
                          type="button"
                          onClick={() => pickSuggestion(s)}
                          class="px-3 py-1.5 rounded-full bg-surface-base border border-border-base/60 text-12-regular text-text-base hover:bg-surface-raised-base-hover hover:border-border-base hover:text-text-strong transition-colors flex items-center gap-1.5"
                          title={
                            s.prompt_seed.slice(0, 200) +
                            (s.prompt_seed.length > 200 ? "…" : "")
                          }
                        >
                          <Icon name={tab.icon as any} class="size-3 text-text-weak" />
                          {s.label}
                        </button>
                      )
                    }}
                  </For>
                  <button
                    type="button"
                    onClick={() => setRefreshKey(refreshKey() + 1)}
                    class="size-7 rounded-full bg-surface-base border border-border-base/60 text-text-weak hover:text-text-base hover:border-border-base transition-colors flex items-center justify-center"
                    title={language.t("builder.suggestions.refresh")}
                    aria-label={language.t("builder.suggestions.refresh")}
                  >
                    <Icon name="reset" class="size-3.5" />
                  </button>
                </div>
              </Match>
            </Switch>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

export default DialogBuilder
