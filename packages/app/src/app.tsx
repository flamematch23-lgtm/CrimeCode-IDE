import "@/index.css"
import { NotificationsProvider } from "@/context/notifications"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Duration, Effect } from "effect"
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { DiagnosticOverlay } from "@/components/diagnostic-overlay"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { LiveShareStateProvider } from "@/context/liveshare-state"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { SharedWorkspacePublisher } from "./components/teams/shared-workspace-publisher"

const HomeRoute = lazy(() => import("@/pages/home"))
const SecurityRoute = lazy(() => import("@/pages/security"))
const BurpWorkspaceRoute = lazy(() => import("@/pages/burp-workspace"))
const AccountRoute = lazy(() => import("@/pages/account"))
const CommunityRoute = lazy(() => import("@/pages/community"))
const ReferralLandingRoute = lazy(() => import("@/pages/referral-landing"))
const Session = lazy(() => import("@/pages/session"))
const Loading = () => <div class="size-full" />

const SessionRoute = () => (
  <ErrorBoundary fallback={(err) => <ErrorPage error={err} />}>
    <SessionProviders>
      <Session />
    </SessionProviders>
  </ErrorBoundary>
)

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __CRIMECODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
      getScreenSources?: (opts?: {
        types?: Array<"screen" | "window">
        thumbnail?: { width: number; height: number }
      }) => Promise<
        Array<{ id: string; name: string; type: "screen" | "window"; thumbnail: string; appIcon: string | null }>
      >
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <PermissionProvider>
      <LayoutProvider>
        <NotificationProvider>
          <LiveShareStateProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <Layout>{props.children}</Layout>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </LiveShareStateProvider>
        </NotificationProvider>
      </LayoutProvider>
    </PermissionProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
        {/* Mounted inside the Router so it can call useLocation /
            useNavigate. Auto-publishes the local workspace state to the
            active team session and, when the local user is following a
            teammate, navigates to the teammate's workspace whenever they
            push a state update. Renders nothing visible. */}
        <SharedWorkspacePublisher />
      </Suspense>
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider>
                    <FileComponentProvider component={File}>
                      <NotificationsProvider>
                        {props.children}
                        <DiagnosticOverlay />
                      </NotificationsProvider>
                    </FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          effectMinDuration(checkMode() === "blocking" ? "1.2 seconds" : 0),
          Effect.timeoutOrElse({ duration: "30 seconds", onTimeout: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  return (
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-40 h-14 object-contain opacity-70 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 5000)
  onCleanup(() => clearInterval(timer))

  // Sidecar diagnostics (Electron-only). On the web build window.api is
  // undefined → the panel stays hidden. When present we surface binary
  // path, exit codes per attempt, recent stderr — the data the user
  // needs to figure out why the local server didn't come up (AV
  // quarantine, missing DLL, port collision, etc.) without digging
  // through %APPDATA%/OpenCode/logs/main.log.
  type SidecarApi = {
    getSidecarDiagnostics?: () => Promise<{
      binaryPath: string | null
      binaryExists: boolean
      url: string | null
      killedIntentionally: boolean
      spawnAttempts: Array<{ attempt: number; port: number; ts: number; code: number | null; signal: number | null }>
      recentStderr: string[]
      lastError: string | null
      logFolder: string
      appVersion: string
      platform: string
      electronVersion: string
    }>
    openLogFolder?: () => Promise<void>
    restartApp?: () => Promise<void>
  }
  const electronApi = (): SidecarApi | null =>
    typeof window !== "undefined" ? ((window as unknown as { api?: SidecarApi }).api ?? null) : null
  const [diagnostics] = createResource(
    () => (electronApi()?.getSidecarDiagnostics ? Date.now() : null),
    async () => {
      const api = electronApi()
      if (!api?.getSidecarDiagnostics) return null
      try {
        return await api.getSidecarDiagnostics()
      } catch {
        return null
      }
    },
  )
  const [diagOpen, setDiagOpen] = createSignal(false)
  const openLogs = () => void electronApi()?.openLogFolder?.()
  const doRestart = () => void electronApi()?.restartApp?.()

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6 overflow-auto">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-32 h-11 mb-4 object-contain" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={diagnostics()}>
        {(d) => (
          <div class="w-full max-w-2xl flex flex-col gap-2">
            <div class="flex gap-2 justify-center flex-wrap">
              <button
                type="button"
                class="px-3 py-1.5 rounded-md text-12-medium bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-base"
                onClick={() => setDiagOpen(!diagOpen())}
              >
                {diagOpen() ? "Hide diagnostics" : "Show diagnostics"}
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-md text-12-medium bg-surface-raised-base hover:bg-surface-raised-base-hover border border-border-base"
                onClick={openLogs}
              >
                Open log folder
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-md text-12-medium bg-icon-warning-base text-background-base font-semibold hover:opacity-90"
                onClick={doRestart}
              >
                Restart app
              </button>
            </div>
            <Show when={diagOpen()}>
              <div class="bg-surface-base rounded-lg p-3 text-12-regular text-text-base flex flex-col gap-1 font-mono leading-relaxed">
                <div>
                  <span class="text-text-weak">App:</span> v{d().appVersion} · Electron {d().electronVersion} · {d().platform}
                </div>
                <div class="break-all">
                  <span class="text-text-weak">Sidecar:</span> {d().binaryPath ?? "(unknown)"}{" "}
                  <span class={d().binaryExists ? "text-icon-success-base" : "text-icon-critical-base"}>
                    [{d().binaryExists ? "exists" : "missing"}]
                  </span>
                </div>
                <div>
                  <span class="text-text-weak">URL:</span> {d().url ?? "(not assigned)"}
                </div>
                <div class="break-all">
                  <span class="text-text-weak">Logs:</span> {d().logFolder}
                </div>
                <Show when={d().lastError}>
                  <div class="text-icon-critical-base">
                    <span class="text-text-weak">Last error:</span> {d().lastError}
                  </div>
                </Show>
                <Show when={d().spawnAttempts.length > 0}>
                  <div class="mt-2">
                    <span class="text-text-weak">Spawn attempts:</span>
                    <For each={d().spawnAttempts}>
                      {(a) => (
                        <div class="pl-3">
                          #{a.attempt} port={a.port} exit code={a.code ?? "?"} signal={a.signal ?? "?"}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={d().recentStderr.length > 0}>
                  <div class="mt-2">
                    <span class="text-text-weak">Recent stderr (last {d().recentStderr.length} lines):</span>
                    <pre class="bg-background-base rounded p-2 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-11-regular">
                      {d().recentStderr.join("\n")}
                    </pre>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider defaultServer={props.defaultServer} servers={props.servers}>
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <SettingsProvider>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <Dynamic
                  component={props.router ?? Router}
                  root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
                >
                  <Route path="/" component={HomeRoute} />
                  <Route path="/security" component={SecurityRoute} />
                  <Route path="/security/burp" component={BurpWorkspaceRoute} />
                  <Route path="/account" component={AccountRoute} />
                  <Route path="/community" component={CommunityRoute} />
                  <Route path="/r/:code" component={ReferralLandingRoute} />
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={SessionIndexRoute} />
                    <Route path="/session/:id?" component={SessionRoute} />
                  </Route>
                </Dynamic>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </SettingsProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
