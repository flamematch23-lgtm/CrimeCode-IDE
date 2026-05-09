/**
 * DialogBuilder — "What do you want to build?" composer.
 *
 * Triggered by the "+" / "New session" button in the workspace sidebar.
 * Collects:
 *   - tab (pentest / exploit / osint / webapp / api / mobile)
 *   - free-form prompt (with placeholder per tab)
 *   - model selection (real, from useProviders())
 *   - chip suggestions fetched from cloud (curated server-side)
 *
 * On Run:
 *   - Creates a new session under the workspace
 *   - Stores `{ sessionId, prompt, model, agent, system }` in
 *     localStorage under `builder.pending` so the session page can
 *     pre-fill the composer + auto-submit on first mount
 *   - Navigates to /<slug>/session/<id>
 *
 * The actual auto-submit is handled in pages/session/* (reads the
 * pending entry and clears it after applying). Without that wiring the
 * user still sees the prompt in the composer ready to send manually,
 * so this dialog is independently shippable.
 */

import { Component, createMemo, createResource, createSignal, For, Show, Switch, Match } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useGlobalSDK } from "@/context/global-sdk"
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
  /** "max" if cost.input > 0 and provider in {opencode,anthropic} top-tier;
   *  "pro" for paid models on standard providers; "free" for free-tier or
   *  $0 cost. Used to render the colored badge next to each model. */
  tier: "max" | "pro" | "free"
}

function classifyTier(input: number, providerId: string, modelId: string): "max" | "pro" | "free" {
  if (input <= 0) return "free"
  // Heuristic: claude-opus + claude-code-* are MAX tier
  const isMax =
    /opus/i.test(modelId) ||
    providerId === "claude-code" ||
    /^gpt-5(?!-mini|-nano)/i.test(modelId) ||
    /gemini-3-pro/i.test(modelId)
  return isMax ? "max" : "pro"
}

export interface DialogBuilderProps {
  /** workspace directory (raw, not base64) where the new session lives */
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

  // Build model options from real connected providers. Filter out the
  // bare "_custom" entry and providers with zero models exposed.
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
    // Order: max → pro → free; within tier, name asc.
    const tierWeight = { max: 0, pro: 1, free: 2 } as const
    out.sort((a, b) => {
      if (a.tier !== b.tier) return tierWeight[a.tier] - tierWeight[b.tier]
      return a.modelName.localeCompare(b.modelName)
    })
    return out
  })

  // Default-select the first model option once they're loaded.
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

  // Suggestions are fetched fresh per tab. createResource auto-refetches
  // when activeTab changes. The refresh button bumps a counter which is
  // also a source so the resource re-runs on click.
  const [refreshKey, setRefreshKey] = createSignal(0)
  const [suggestions] = createResource(
    () => ({ tab: activeTab(), key: refreshKey() }),
    async (input) => {
      return fetchBuilderTemplates(input.tab, 4)
    },
  )

  const placeholder = createMemo(() => {
    const tab = activeTab()
    return language.t(`builder.placeholder.${tab}` as any)
  })

  const pickSuggestion = (s: BuilderTemplate) => {
    setPrompt(s.prompt_seed)
  }

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
      // Hand off the pending prompt to the session page via localStorage.
      // The session page reads + clears this on first mount and applies
      // it to the composer. If the session page doesn't pick it up
      // (stale build), the user simply lands on an empty session — the
      // dialog UI itself doesn't lock anything.
      try {
        localStorage.setItem(
          "builder.pending",
          JSON.stringify({
            sessionId: created.id,
            prompt: text,
            tab: activeTab(),
            providerId: model.providerId,
            modelId: model.modelId,
            agent: agentNameForTab(activeTab()),
            system: systemPromptForTab(activeTab()),
            ts: Date.now(),
          }),
        )
      } catch {
        /* private mode / quota — non-fatal */
      }
      dialog.close()
      navigate(`/${base64Encode(props.workspaceDirectory)}/session/${created.id}`)
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

  return (
    <Dialog title={language.t("builder.title")} transition>
      <div class="flex flex-col gap-4 px-2.5 pb-3 w-[680px] max-w-[90vw]">
        <div class="text-13-regular text-text-weak px-2.5">{language.t("builder.subtitle")}</div>

        {/* Tabs */}
        <div class="flex gap-1 px-2.5 border-b border-surface-weak overflow-x-auto">
          <For each={TABS}>
            {(t) => (
              <button
                onClick={() => setActiveTab(t.id)}
                class="px-3 py-2 text-12-regular flex items-center gap-1.5 border-b-2 transition-colors whitespace-nowrap"
                classList={{
                  "border-icon-warning-base text-text-strong": activeTab() === t.id,
                  "border-transparent text-text-weak hover:text-text-base": activeTab() !== t.id,
                }}
              >
                <Icon name={t.icon as any} class="size-3.5" />
                {language.t(`builder.tab.${t.id}` as any)}
              </button>
            )}
          </For>
        </div>

        {/* Prompt textarea + bottom toolbar */}
        <div class="px-2.5 flex flex-col gap-2">
          <textarea
            class="w-full min-h-[140px] max-h-[280px] resize-y rounded-md bg-surface-weak/40 border border-border-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:border-icon-warning-base"
            placeholder={placeholder()}
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                void handleRun()
              }
            }}
            disabled={submitting()}
          />

          <div class="flex items-center gap-3 flex-wrap">
            {/* Model picker */}
            <Show
              when={modelOptions().length > 0}
              fallback={
                <span class="text-12-regular text-icon-warning-base">
                  {language.t("builder.error.noModel")}
                </span>
              }
            >
              <label class="flex items-center gap-2 text-12-regular text-text-weak">
                <span>{language.t("builder.model.label")}:</span>
                <select
                  class="bg-surface-weak/40 border border-border-base rounded px-2 py-1 text-12-regular text-text-strong"
                  value={
                    selectedModelKey() ??
                    (selectedModel()
                      ? `${selectedModel()!.providerId}/${selectedModel()!.modelId}`
                      : "")
                  }
                  onChange={(e) => setSelectedModelKey(e.currentTarget.value)}
                  disabled={submitting()}
                >
                  <For each={modelOptions()}>
                    {(m) => (
                      <option value={`${m.providerId}/${m.modelId}`}>
                        {m.modelName} · {m.providerName} [{language.t(`builder.model.tier.${m.tier}` as any)}]
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>

            <div class="flex-1" />
            <Button
              variant="ghost"
              size="small"
              onClick={() => dialog.close()}
              disabled={submitting()}
            >
              {language.t("builder.action.cancel")}
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={() => void handleRun()}
              disabled={!prompt().trim() || submitting() || modelOptions().length === 0}
            >
              {submitting() ? "…" : language.t("builder.action.run")}
            </Button>
          </div>
        </div>

        {/* Suggestions chips */}
        <div class="px-2.5 flex flex-col gap-2 pt-2 border-t border-surface-weak">
          <div class="flex items-center gap-2">
            <span class="text-11-regular text-text-weak font-medium uppercase tracking-wide">
              {language.t("builder.suggestions.label")}
            </span>
            <IconButton
              icon="reset"
              variant="ghost"
              onClick={() => setRefreshKey(refreshKey() + 1)}
              aria-label={language.t("builder.suggestions.refresh")}
              class="size-5"
            />
          </div>
          <Switch>
            <Match when={suggestions.loading}>
              <span class="text-12-regular text-text-weak">
                {language.t("builder.suggestions.loading")}
              </span>
            </Match>
            <Match when={!suggestions.loading && (suggestions()?.length ?? 0) === 0}>
              <span class="text-12-regular text-text-weak">
                {language.t("builder.suggestions.empty")}
              </span>
            </Match>
            <Match when={(suggestions()?.length ?? 0) > 0}>
              <div class="flex flex-wrap gap-1.5">
                <For each={suggestions()}>
                  {(s) => (
                    <button
                      onClick={() => pickSuggestion(s)}
                      class="px-3 py-1.5 rounded-full bg-surface-weak/40 border border-border-base text-12-regular text-text-base hover:bg-surface-raised-base-hover hover:text-text-strong transition-colors"
                      title={s.prompt_seed.slice(0, 200) + (s.prompt_seed.length > 200 ? "…" : "")}
                    >
                      {s.label}
                    </button>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  )
}

export default DialogBuilder
