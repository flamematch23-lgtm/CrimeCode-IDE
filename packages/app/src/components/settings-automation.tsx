import { Component, For, Show, createMemo, createResource, createSignal, onMount, type JSX } from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform, type ComputerUseStatus } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { Link } from "./link"
import { SettingsList } from "./settings-list"

/**
 * Settings → Automation panel.
 *
 * Four pieces, each backed by its own service in the Electron main process:
 *
 *  1. **Browser usage / "Consenti tutte le azioni del browser"**
 *     - persists to electron-store (`automation.browserAllowAll`)
 *     - `browserService.setAllowAll(true)` short-circuits the per-action
 *       permission gate at the Playwright wrapper layer.
 *
 *  2. **Connected browsers** (read-only list)
 *     - DevTools Protocol probe on a small set of localhost debug ports.
 *     - "Ricontrolla" re-runs the probe on demand.
 *
 *  3. **Computer use (Beta)**
 *     - Activation goes through a nested confirmation dialog (the same
 *       warning copy Anthropic shows on its desktop app).
 *     - Main process verifies OS permissions (macOS Screen Recording +
 *       Accessibility, Wayland availability) before flipping the toggle.
 *
 *  4. **Restore apps on Claude exit**
 *     - Owns the user preference; the actual lifecycle is hooked into
 *       `app.on('before-quit')` in the main process.
 *
 * The whole tab is hidden when `platform.automation` is undefined (e.g. on
 * the web build), so the panel never lies to the user about what works.
 */
export const SettingsAutomation: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  // Computer-use confirmation runs as a NESTED modal on top of DialogSettings.
  // We can't use the global `useDialog().show()` here because that helper
  // disposes the currently-open dialog before mounting the new one — we'd
  // tear down the settings dialog the moment the user opened the confirm.
  // Instead, we own a local Kobalte.Root whose `open` is driven by a signal,
  // which stacks correctly above the parent dialog and keeps focus-trap +
  // ESC handling working for both layers.
  const [confirmingComputerUse, setConfirmingComputerUse] = createSignal(false)
  const [confirmSubmitting, setConfirmSubmitting] = createSignal(false)

  // The renderer keeps its own settings store, but the source of truth for
  // these toggles is the main process. We hydrate from main on mount so a
  // value flipped from another window or restored from disk wins over the
  // local store.
  onMount(() => {
    const auto = platform.automation
    if (!auto) return

    void auto.getBrowserAllowAll().then((value) => {
      if (value !== settings.automation.browserAllowAll()) {
        settings.automation.setBrowserAllowAll(value)
      }
    })

    void auto.getComputerUseStatus().then((status) => {
      if (status.enabled !== settings.automation.computerUseEnabled()) {
        settings.automation.setComputerUseEnabled(status.enabled)
      }
    })

    void auto.getRestoreApps().then((status) => {
      if (status.enabled !== settings.automation.restoreAppsOnExit()) {
        settings.automation.setRestoreAppsOnExit(status.enabled)
      }
    })
  })

  // Connected-browsers probe. Stays empty when the desktop bridge isn't
  // available (web build, broken IPC) so the empty-state copy renders.
  const [browsers, browsersActions] = createResource(
    () => platform.automation,
    async (auto) => {
      if (!auto) return []
      try {
        return await auto.listConnectedBrowsers()
      } catch {
        return []
      }
    },
    { initialValue: [] },
  )

  const handleBrowserAllowAllChange = async (value: boolean) => {
    settings.automation.setBrowserAllowAll(value) // optimistic
    try {
      await platform.automation?.setBrowserAllowAll(value)
    } catch (err) {
      // Roll back the optimistic update; the failure toast names the action so
      // the user knows nothing was persisted.
      settings.automation.setBrowserAllowAll(!value)
      showToast({
        variant: "error",
        title: language.t("settings.automation.browserAllowAll.failed"),
        description: errorMessage(err),
      })
    }
  }

  const handleComputerUseChange = async (value: boolean) => {
    if (!value) {
      // Deactivation never needs confirmation — flip immediately.
      settings.automation.setComputerUseEnabled(false)
      try {
        await platform.automation?.setComputerUseEnabled(false)
      } catch (err) {
        settings.automation.setComputerUseEnabled(true)
        showToast({
          variant: "error",
          title: language.t("settings.automation.computerUse.failed"),
          description: errorMessage(err),
        })
      }
      return
    }

    // Activation: open the local confirmation dialog. Activation only happens
    // after the user explicitly clicks "Attiva" inside the modal.
    setConfirmingComputerUse(true)
  }

  const confirmComputerUseActivation = async () => {
    if (confirmSubmitting()) return
    setConfirmSubmitting(true)
    try {
      const status = await platform.automation?.setComputerUseEnabled(true)
      if (!status) return
      settings.automation.setComputerUseEnabled(status.enabled)
      if (!status.enabled) {
        showToast({
          variant: "error",
          icon: "shield",
          title: language.t("settings.automation.computerUse.activationDenied.title"),
          description: language.t(reasonI18nKey(status.reason)),
        })
      }
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.automation.computerUse.failed"),
        description: errorMessage(err),
      })
    } finally {
      setConfirmSubmitting(false)
      setConfirmingComputerUse(false)
    }
  }

  const handleRestoreAppsChange = async (value: boolean) => {
    settings.automation.setRestoreAppsOnExit(value) // optimistic
    try {
      const status = await platform.automation?.setRestoreApps(value)
      if (status && status.enabled !== value) {
        settings.automation.setRestoreAppsOnExit(status.enabled)
      }
    } catch (err) {
      settings.automation.setRestoreAppsOnExit(!value)
      showToast({
        variant: "error",
        title: language.t("settings.automation.restoreApps.failed"),
        description: errorMessage(err),
      })
    }
  }

  const automationAvailable = createMemo(() => !!platform.automation)

  // ─── Sections ───────────────────────────────────────────────────────

  const BrowserSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.automation.section.browser")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.automation.row.browserAllowAll.title")}
          description={
            <>
              {language.t("settings.automation.row.browserAllowAll.description")}{" "}
              <Link href="https://opencode.ai/docs/automation/browser/">{language.t("common.learnMore")}</Link>
            </>
          }
        >
          <div data-action="settings-automation-browser-allow-all">
            <Switch
              checked={settings.automation.browserAllowAll()}
              disabled={!automationAvailable()}
              onChange={(checked) => void handleBrowserAllowAllChange(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>

      <div class="flex flex-col gap-2 pt-4">
        <div class="flex items-center justify-between">
          <span class="text-12-medium text-text-strong">
            {language.t("settings.automation.connectedBrowsers.title")}
          </span>
          <Button
            size="small"
            variant="secondary"
            disabled={!automationAvailable() || browsers.loading}
            onClick={() => void browsersActions.refetch()}
          >
            <Icon name="reset" />
            {browsers.loading
              ? language.t("settings.automation.connectedBrowsers.refreshing")
              : language.t("settings.automation.connectedBrowsers.refresh")}
          </Button>
        </div>
        <span class="text-12-regular text-text-weak">
          {language.t("settings.automation.connectedBrowsers.description")}
        </span>
        <ConnectedBrowsersList items={browsers() ?? []} loading={browsers.loading} />
      </div>
    </div>
  )

  const ComputerUseSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.automation.section.computerUse")}</h3>

      <SettingsList>
        <SettingsRow
          title={
            <span class="flex items-center gap-2">
              {language.t("settings.automation.row.computerUse.title")}
              <span class="text-10-medium px-1.5 py-0.5 rounded bg-surface-info-base text-text-info">
                {language.t("common.beta")}
              </span>
            </span>
          }
          description={language.t("settings.automation.row.computerUse.description")}
        >
          <div data-action="settings-automation-computer-use">
            <Switch
              checked={settings.automation.computerUseEnabled()}
              disabled={!automationAvailable()}
              onChange={(checked) => void handleComputerUseChange(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.automation.row.restoreApps.title")}
          description={language.t("settings.automation.row.restoreApps.description")}
        >
          <div data-action="settings-automation-restore-apps">
            <Switch
              checked={settings.automation.restoreAppsOnExit()}
              disabled={!automationAvailable()}
              onChange={(checked) => void handleRestoreAppsChange(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const UnsupportedNotice = () => (
    <div class="flex items-start gap-3 px-4 py-3 rounded-lg bg-surface-warning-base/30 border border-border-warning-base">
      <Icon name="warning" class="text-icon-warning mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-13-medium text-text-strong">
          {language.t("settings.automation.unsupported.title")}
        </span>
        <span class="text-12-regular text-text-weak">
          {language.t("settings.automation.unsupported.description")}
        </span>
      </div>
    </div>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.automation")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.automation.tagline")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <Show when={!automationAvailable()}>
          <UnsupportedNotice />
        </Show>

        <BrowserSection />
        <ComputerUseSection />
      </div>

      {/* Nested confirm dialog. Mounted as a Kobalte.Root so it stacks above
          the parent DialogSettings without disposing it. */}
      <Kobalte
        modal
        open={confirmingComputerUse()}
        onOpenChange={(open) => {
          if (confirmSubmitting()) return // ignore ESC / overlay click while submitting
          setConfirmingComputerUse(open)
        }}
      >
        <Kobalte.Portal>
          <Kobalte.Overlay
            data-component="dialog-overlay"
            onClick={() => {
              if (!confirmSubmitting()) setConfirmingComputerUse(false)
            }}
          />
          <Dialog
            title={language.t("settings.automation.computerUse.confirm.title")}
            class="w-full max-w-[440px] mx-auto"
          >
            <div class="flex flex-col gap-4 px-6 pb-6 pt-0">
              <p class="text-13-regular text-text-base">
                {language.t("settings.automation.computerUse.confirm.body")}
              </p>

              <div class="flex flex-col gap-2">
                <span class="text-13-medium text-text-strong">
                  {language.t("settings.automation.computerUse.confirm.warningHeader")}
                </span>
                <ul class="flex flex-col gap-1.5 list-disc pl-5 text-12-regular text-text-weak">
                  <li>{language.t("settings.automation.computerUse.confirm.warning1")}</li>
                  <li>{language.t("settings.automation.computerUse.confirm.warning2")}</li>
                  <li>{language.t("settings.automation.computerUse.confirm.warning3")}</li>
                  <li>{language.t("settings.automation.computerUse.confirm.warning4")}</li>
                </ul>
              </div>

              <p class="text-12-regular text-text-weak">
                {language.t("settings.automation.computerUse.confirm.disclaimer")}{" "}
                <Link href="https://opencode.ai/docs/automation/computer-use/safety/">
                  {language.t("settings.automation.computerUse.confirm.safetyLink")}
                </Link>
              </p>

              <div class="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="large"
                  onClick={() => setConfirmingComputerUse(false)}
                  disabled={confirmSubmitting()}
                >
                  {language.t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  onClick={() => void confirmComputerUseActivation()}
                  disabled={confirmSubmitting()}
                >
                  {confirmSubmitting()
                    ? language.t("settings.automation.computerUse.confirm.activating")
                    : language.t("settings.automation.computerUse.confirm.activate")}
                </Button>
              </div>
            </div>
          </Dialog>
        </Kobalte.Portal>
      </Kobalte>
    </div>
  )
}

// ─── Local helpers / sub-components ──────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function reasonI18nKey(reason: ComputerUseStatus["reason"]) {
  switch (reason) {
    case "platform-unsupported":
      return "settings.automation.computerUse.activationDenied.platform"
    case "permission-denied":
      return "settings.automation.computerUse.activationDenied.permission"
    case "not-activated":
    default:
      return "settings.automation.computerUse.activationDenied.generic"
  }
}

const ConnectedBrowsersList: Component<{
  items: { id: string; label: string; url: string; port: number }[]
  loading: boolean
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-base">
      <Show
        when={props.items.length > 0}
        fallback={
          <div class="px-3 py-4 text-12-regular text-text-weak">
            <Show when={props.loading} fallback={language.t("settings.automation.connectedBrowsers.empty")}>
              {language.t("settings.automation.connectedBrowsers.refreshing")}
            </Show>
          </div>
        }
      >
        <div class="flex flex-col">
          <For each={props.items}>
            {(item) => (
              <div class="flex items-center gap-3 px-3 py-2.5 border-b border-border-weak-base last:border-none">
                <Icon name="share" />
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="text-12-medium text-text-strong truncate">{item.label}</span>
                  <span class="text-11-regular text-text-weak truncate">{item.url || `:${item.port}`}</span>
                </div>
                <span class="text-10-regular text-text-dimmed">:{item.port}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
