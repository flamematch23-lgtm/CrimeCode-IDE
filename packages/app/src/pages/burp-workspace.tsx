import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"

/**
 * Burp Workspace — interactive UI on top of the local Burp-style toolkit.
 *
 * Talks to the proxy's REST control API (start with:
 *   `bun http-proxy.ts start --intercept --api-port 8182`).
 *
 * Three live panels, plus an AI agent collaboration footer that emits
 * a copy-pasteable prompt referencing the currently selected flow / pending
 * intercept / finding so the user can drop it straight into the agent
 * composer.
 */

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

interface FlowSummary {
  id: number
  ts: number
  method: string
  scheme: string
  host: string
  port: number
  path: string
  status: number | null
  resp_body_size: number | null
  duration_ms: number | null
  flagged: number
  resp_content_type: string | null
}

interface FlowDetail extends FlowSummary {
  req_headers: Record<string, string>
  resp_headers: Record<string, string>
  req_body: string
  resp_body: string
}

interface PendingItem {
  id: number
  ts: number
  phase: string
  method: string
  scheme: string
  host: string
  port: number
  path: string
  status: string
  headers: Record<string, string>
  body: string
}

interface RuleRow {
  id: number
  enabled: number
  type: string
  scope: string
  match: string
  replace: string
  description: string | null
}

interface SettingsState {
  intercept: boolean
  port: number
  flowCount: number
  pendingCount: number
}

function makeApi(base: string) {
  const j = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body && typeof body === "object" && "error" in body) msg = String((body as { error: string }).error)
      } catch {
        /* ignore */
      }
      throw new Error(msg)
    }
    return res.status === 204 ? null : res.json()
  }

  return {
    health: () => j("/health"),
    settings: () => j("/settings") as Promise<SettingsState>,
    setIntercept: (on: boolean) => j("/settings/intercept", { method: "POST", body: JSON.stringify({ on }) }),
    flows: (params?: { limit?: number; host?: string; status?: number; grep?: string }) => {
      const qs = new URLSearchParams()
      if (params?.limit) qs.set("limit", String(params.limit))
      if (params?.host) qs.set("host", params.host)
      if (params?.status) qs.set("status", String(params.status))
      if (params?.grep) qs.set("grep", params.grep)
      const q = qs.toString()
      return j(`/flows${q ? "?" + q : ""}`) as Promise<FlowSummary[]>
    },
    flow: (id: number) => j(`/flows/${id}`) as Promise<FlowDetail>,
    flagFlow: (id: number) => j(`/flows/${id}/flag`, { method: "POST" }),
    pending: () => j(`/pending`) as Promise<PendingItem[]>,
    forwardPending: (id: number) => j(`/pending/${id}/forward`, { method: "POST" }),
    dropPending: (id: number) => j(`/pending/${id}/drop`, { method: "POST" }),
    editPending: (id: number, body: { method?: string; url?: string; headers?: Record<string, string>; body?: string }) =>
      j(`/pending/${id}/edit`, { method: "POST", body: JSON.stringify(body) }),
    rules: () => j("/rules") as Promise<RuleRow[]>,
    addRule: (r: { type: string; scope: string; match: string; replace?: string; description?: string }) =>
      j("/rules", { method: "POST", body: JSON.stringify(r) }),
    deleteRule: (id: number) => j(`/rules/${id}`, { method: "DELETE" }),
    toggleRule: (id: number) => j(`/rules/${id}/toggle`, { method: "POST" }),
    stats: () => j("/stats"),
    eventsUrl: () => `${base}/events`,
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Panel = "flows" | "intercept" | "rules" | "agent"

export default function BurpWorkspace() {
  const navigate = useNavigate()
  const [apiBase, setApiBase] = createSignal(localStorage.getItem("burp.apiBase") ?? "http://127.0.0.1:8182")
  const api = createMemo(() => makeApi(apiBase()))

  const [panel, setPanel] = createSignal<Panel>("flows")
  const [filter, setFilter] = createSignal("")
  const [selectedFlow, setSelectedFlow] = createSignal<number | null>(null)
  const [selectedPending, setSelectedPending] = createSignal<number | null>(null)
  const [connected, setConnected] = createSignal(false)

  const [settings, setSettings] = createSignal<SettingsState | null>(null)
  const [flows, setFlows] = createSignal<FlowSummary[]>([])
  const [pending, setPending] = createSignal<PendingItem[]>([])
  const [rules, setRules] = createSignal<RuleRow[]>([])
  const [startingProxy, setStartingProxy] = createSignal(false)
  const [startError, setStartError] = createSignal<string | null>(null)

  // Connection lifecycle:
  //   - while connected: SSE stream + a 4 s settings poll
  //   - while disconnected: backoff esponenziale 2s → 4s → 8s → … → 5min
  //     (cap ALTO perché il proxy locale è una feature opt-in che la
  //     maggioranza degli utenti non accenderà mai — meglio retry rari).
  //   - quando la tab non è visibile: STOP COMPLETO dei retry. Riprende
  //     immediatamente al ritorno foreground.
  //   - dopo MAX_FAIL_BEFORE_GIVE_UP retry consecutivi falliti, smette
  //     del tutto: l'utente deve cliccare "Riprova" / "Avvia proxy" per
  //     riattivare. Evita rumore infinito quando l'utente apre la pagina
  //     per curiosità senza mai voler usare il proxy.
  let evtSource: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelayMs = 2000
  let consecutiveFailures = 0
  let givenUp = false
  let documentVisible = typeof document !== "undefined" ? !document.hidden : true
  let settingsTimer: ReturnType<typeof setInterval> | null = null
  const MAX_FAIL_BEFORE_GIVE_UP = 8 // ~ dopo ≈ 12 minuti totali smette
  const MAX_BACKOFF_MS = 5 * 60_000 // 5 minuti

  const stopPollingAndSse = () => {
    if (evtSource) {
      evtSource.close()
      evtSource = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (settingsTimer) {
      clearInterval(settingsTimer)
      settingsTimer = null
    }
  }

  const cancelRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleRetry = () => {
    cancelRetry()
    if (givenUp) return
    if (!documentVisible) return // resume on visibility change
    retryTimer = setTimeout(() => {
      retryTimer = null
      void refreshAll()
    }, retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_BACKOFF_MS)
  }

  // Initial load + polling/SSE
  const refreshAll = async (): Promise<boolean> => {
    try {
      const [s, f, p, r] = await Promise.all([
        api().settings(),
        api().flows({ limit: 200 }),
        api().pending(),
        api().rules(),
      ])
      setSettings(s)
      setFlows(f)
      setPending(p)
      setRules(r)
      const wasConnected = connected()
      setConnected(true)
      retryDelayMs = 2000 // reset backoff
      consecutiveFailures = 0
      givenUp = false
      cancelRetry()
      if (!wasConnected) startLiveSubscriptions()
      return true
    } catch (e) {
      const wasConnected = connected()
      setConnected(false)
      consecutiveFailures++
      if (wasConnected) {
        // Lost connection mid-session — tear down active subs and
        // schedule a fresh retry (backoff resets on next success).
        stopPollingAndSse()
      }
      if (consecutiveFailures >= MAX_FAIL_BEFORE_GIVE_UP) {
        givenUp = true
        cancelRetry()
        return false
      }
      scheduleRetry()
      return false
    }
  }

  const startLiveSubscriptions = () => {
    stopPollingAndSse()
    try {
      evtSource = new EventSource(api().eventsUrl())
      evtSource.addEventListener("flow", () => void api().flows({ limit: 200 }).then(setFlows).catch(() => undefined))
      evtSource.addEventListener("pending", () => void api().pending().then(setPending).catch(() => undefined))
      evtSource.addEventListener("resolved", () => void api().pending().then(setPending).catch(() => undefined))
      evtSource.onerror = () => {
        // SSE dropped after a successful initial connect — kick off a
        // refreshAll cycle which will either re-establish or transition
        // us back to the disconnected backoff state.
        if (evtSource) {
          evtSource.close()
          evtSource = null
        }
        void refreshAll()
      }
    } catch {
      // EventSource constructor failure is rare (usually CSP). Fall back
      // to a slow poll while we're connected, just to keep state fresh.
      pollTimer = setInterval(() => void refreshAll(), 5000)
    }
    // Lightweight settings poll to refresh "intercept" + "pendingCount"
    // pill in the header. Cheap (~few hundred bytes), 4 s cadence.
    settingsTimer = setInterval(() => {
      void api()
        .settings()
        .then(setSettings)
        .catch(() => {
          // Single failure → trigger a full refresh which will detect
          // the disconnect and transition state cleanly.
          void refreshAll()
        })
    }, 4000)
  }

  onMount(() => {
    void refreshAll()
    // Pausa retry quando la tab non è visibile (Electron lo emette anche
    // quando minimizzi la window). Riprende immediatamente al ritorno.
    const onVisibility = () => {
      const visible = !document.hidden
      documentVisible = visible
      if (visible) {
        // Resetta lo stato "given up" quando l'utente torna sulla tab —
        // probabilmente vuole effettivamente vedere lo stato.
        if (givenUp) {
          givenUp = false
          retryDelayMs = 2000
          consecutiveFailures = 0
        }
        if (!connected()) void refreshAll()
      } else {
        cancelRetry()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility)
      stopPollingAndSse()
      cancelRetry()
    })
  })

  const persistApiBase = (v: string) => {
    setApiBase(v)
    localStorage.setItem("burp.apiBase", v)
    retryDelayMs = 2000
    consecutiveFailures = 0
    givenUp = false
    cancelRetry()
    void refreshAll()
  }

  const manualRetry = () => {
    retryDelayMs = 2000
    consecutiveFailures = 0
    givenUp = false
    cancelRetry()
    void refreshAll()
  }

  const startProxy = async () => {
    setStartingProxy(true)
    setStartError(null)
    try {
      const proxy = (window as { api?: { proxy?: { startBurp?: (port: number) => Promise<{ ok: boolean; error?: string }> } } }).api?.proxy
      if (!proxy?.startBurp) {
        setStartError("Avvio automatico non disponibile in questa build. Avvialo manualmente con il comando mostrato sopra.")
        return
      }
      const port = Number(new URL(apiBase()).port || "8182")
      const result = await proxy.startBurp(port)
      if (!result.ok) {
        setStartError(result.error ?? "Avvio fallito")
        return
      }
      // Give the proxy ~1 s to bind, then trigger a refresh
      setTimeout(() => {
        retryDelayMs = 2000
        cancelRetry()
        void refreshAll()
      }, 1000)
    } catch (e) {
      setStartError((e as Error).message)
    } finally {
      setStartingProxy(false)
    }
  }

  const toggleIntercept = async () => {
    const cur = settings()?.intercept ?? false
    try {
      await api().setIntercept(!cur)
      setSettings((s) => (s ? { ...s, intercept: !cur } : s))
      showToast({ variant: "success", title: `Intercept → ${!cur ? "ON" : "OFF"}` })
    } catch (e) {
      showToast({ variant: "error", title: "Setting failed", description: (e as Error).message })
    }
  }

  // Filtered flow list
  const filteredFlows = createMemo(() => {
    const f = filter().toLowerCase()
    if (!f) return flows()
    return flows().filter(
      (x) =>
        (x.host + x.path).toLowerCase().includes(f) ||
        x.method.toLowerCase().includes(f) ||
        String(x.status ?? "").includes(f),
    )
  })

  return (
    <div class="size-full flex flex-col bg-background-base text-text-strong">
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-weak bg-surface-base">
        <IconButton icon="arrow-left" variant="ghost" onClick={() => navigate("/security")} aria-label="Indietro" />
        <div class="flex-1">
          <h1 class="text-14-semibold">Burp Workspace</h1>
          <p class="text-11-regular text-text-weak">
            MITM proxy live · interagisci con i flow e collabora con l'agente AI
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span
            class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-11-regular"
            classList={{
              "bg-surface-success/30 text-text-strong": connected(),
              "bg-surface-warning/30 text-text-strong": !connected(),
            }}
          >
            <span
              class="size-2 rounded-full"
              classList={{
                "bg-icon-success-base": connected(),
                "bg-icon-warning-base animate-pulse": !connected(),
              }}
            />
            {connected() ? "Connesso" : "Offline"}
          </span>
          <Show when={settings()}>
            {(s) => (
              <span class="text-11-regular text-text-weak">
                porta {s().port} · {s().flowCount} flussi · {s().pendingCount} in attesa
              </span>
            )}
          </Show>
          <Button
            variant={settings()?.intercept ? "primary" : "secondary"}
            size="small"
            onClick={toggleIntercept}
            disabled={!connected()}
          >
            Intercept {settings()?.intercept ? "ON" : "OFF"}
          </Button>
        </div>
      </div>

      <Show when={!connected()}>
        <div class="flex flex-col items-center gap-3 px-4 py-8 bg-surface-warning/10 border-b border-surface-warning text-center">
          <Icon name="circle-ban-sign" class="size-6 text-icon-warning-base" />
          <div class="text-12-regular">
            Impossibile contattare il Control API del proxy a <code class="text-text-strong">{apiBase()}</code>.
            <br />
            Puoi avviarlo direttamente da qui (consigliato) oppure manualmente con:
            <code class="block mt-2 px-3 py-2 bg-surface-base rounded text-12-mono text-text-strong">
              bun packages/opencode/script/agent-tools/security/http-proxy.ts start --intercept --api-port 8182
            </code>
          </div>
          <Show when={startError()}>
            <div class="text-11-regular text-text-on-critical-base bg-surface-critical-weak px-3 py-1.5 rounded">
              {startError()}
            </div>
          </Show>
          <div class="flex gap-2 items-center flex-wrap justify-center">
            <Button variant="primary" size="small" onClick={startProxy} disabled={startingProxy()}>
              {startingProxy() ? "Avvio…" : "Avvia proxy ora"}
            </Button>
            <TextField
              type="text"
              label="API URL"
              value={apiBase()}
              onChange={persistApiBase}
              placeholder="http://127.0.0.1:8182"
            />
            <Button variant="secondary" size="small" onClick={manualRetry}>
              Riprova
            </Button>
            <Button variant="secondary" size="small" onClick={() => navigate("/security")}>
              Indietro a Sicurezza
            </Button>
          </div>
          <div class="text-10-regular text-text-weak max-w-2xl">
            Il Burp Workspace è un'**utilità opt-in** per il toolkit di sicurezza: serve un proxy MITM locale running
            (vedi comando sopra). Se non lo stai usando, torna indietro — i retry sono già throttled (backoff 2s→5min,
            stop a tab nascosta, stop dopo 8 fail consecutivi). Il polling NON tocca la tua GPU né altri sistemi: sono
            solo controlli HTTP locali a vuoto fino a quando avvii il proxy.
          </div>
        </div>
      </Show>

      {/* Tabs */}
      <div class="flex gap-1 px-4 pt-3 pb-2 border-b border-surface-weak bg-surface-base">
        <For
          each={[
            { id: "flows" as const, label: "Flussi", icon: "code-lines", count: flows().length },
            { id: "intercept" as const, label: "Intercept", icon: "circle-ban-sign", count: pending().length },
            { id: "rules" as const, label: "Match&Replace", icon: "folder-add-left", count: rules().length },
            { id: "agent" as const, label: "Collabora con AI", icon: "code-lines", count: 0 },
          ]}
        >
          {(t) => (
            <button
              onClick={() => setPanel(t.id)}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-12-regular transition-colors"
              classList={{
                "bg-icon-warning-base text-text-contrast": panel() === t.id,
                "bg-surface-weak text-text-secondary hover:bg-surface-raised-base-hover": panel() !== t.id,
              }}
            >
              <Icon name={t.icon as any} class="size-4" />
              {t.label}
              <Show when={t.count > 0}>
                <span class="text-10-regular px-1.5 rounded bg-surface-base/50">{t.count}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      {/* Body */}
      <div class="flex-1 min-h-0 flex">
        <Switch>
          <Match when={panel() === "flows"}>
            <FlowsPanel
              flows={filteredFlows()}
              filter={filter()}
              onFilter={setFilter}
              selected={selectedFlow()}
              onSelect={setSelectedFlow}
              api={api}
            />
          </Match>
          <Match when={panel() === "intercept"}>
            <InterceptPanel pending={pending()} selected={selectedPending()} onSelect={setSelectedPending} api={api} />
          </Match>
          <Match when={panel() === "rules"}>
            <RulesPanel rules={rules()} api={api} onChange={() => void refreshAll()} />
          </Match>
          <Match when={panel() === "agent"}>
            <AgentPanel
              selectedFlow={selectedFlow()}
              flows={flows()}
              pending={pending()}
              api={api}
              onNavigateToAgent={() => navigate("/")}
            />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flows panel
// ---------------------------------------------------------------------------

function FlowsPanel(props: {
  flows: FlowSummary[]
  filter: string
  onFilter: (v: string) => void
  selected: number | null
  onSelect: (id: number | null) => void
  api: () => ReturnType<typeof makeApi>
}) {
  const [detail] = createResource(
    () => props.selected,
    async (id) => (id ? await props.api().flow(id) : null),
  )
  return (
    <>
      <div class="w-1/2 max-w-2xl flex flex-col border-r border-surface-weak">
        <div class="px-3 py-2 border-b border-surface-weak bg-surface-base">
          <TextField
            type="text"
            label=""
            placeholder="Filtra per host, path, method, status…"
            value={props.filter}
            onChange={props.onFilter}
          />
        </div>
        <div class="flex-1 overflow-y-auto">
          <Show
            when={props.flows.length > 0}
            fallback={<div class="p-8 text-center text-12-regular text-text-weak">Nessun flusso ancora.</div>}
          >
            <For each={props.flows}>
              {(f) => (
                <button
                  onClick={() => props.onSelect(f.id)}
                  class="w-full text-left px-3 py-2 border-b border-surface-weak hover:bg-surface-raised-base-hover transition-colors"
                  classList={{
                    "bg-surface-raised-base-hover": props.selected === f.id,
                  }}
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-11-mono text-text-weak shrink-0">#{f.id}</span>
                    <span class="text-11-mono text-text-strong w-12 shrink-0">{f.method}</span>
                    <span
                      class="text-11-mono w-10 shrink-0 text-right"
                      classList={{
                        "text-icon-success-base": (f.status ?? 0) >= 200 && (f.status ?? 0) < 300,
                        "text-icon-warning-base": (f.status ?? 0) >= 300 && (f.status ?? 0) < 400,
                        "text-text-on-critical-base": (f.status ?? 0) >= 400,
                      }}
                    >
                      {f.status ?? "—"}
                    </span>
                    <span class="text-11-regular text-text-strong truncate">
                      {f.scheme}://{f.host}
                      {f.path}
                    </span>
                  </div>
                  <div class="flex items-center gap-3 text-10-regular text-text-weak mt-0.5">
                    <span>{(f.resp_body_size ?? 0).toLocaleString()} B</span>
                    <span>{f.duration_ms ?? "—"} ms</span>
                    <Show when={f.flagged}>
                      <span class="text-icon-warning-base">🚩 flagged</span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
      <div class="flex-1 min-w-0 overflow-y-auto p-4">
        <Show
          when={detail()}
          fallback={
            <div class="text-center text-12-regular text-text-weak pt-12">
              Seleziona un flusso a sinistra per vederne il dettaglio.
            </div>
          }
        >
          {(d) => (
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <h3 class="text-14-semibold">
                  {d().method} {d().scheme}://{d().host}
                  {d().path}
                </h3>
                <div class="flex gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={async () => {
                      await props.api().flagFlow(d().id)
                      showToast({ variant: "success", title: `Flow #${d().id} flagged` })
                    }}
                  >
                    Flag
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                      const json = JSON.stringify(
                        {
                          url: `${d().scheme}://${d().host}${d().path}`,
                          method: d().method,
                          headers: d().req_headers,
                          body: d().req_body,
                        },
                        null,
                        2,
                      )
                      void navigator.clipboard.writeText(json)
                      showToast({ variant: "success", title: "Copiato (repeater payload)" })
                    }}
                  >
                    Copia per Repeater
                  </Button>
                </div>
              </div>
              <details open>
                <summary class="text-12-semibold cursor-pointer mb-1">Request headers</summary>
                <pre class="text-11-mono whitespace-pre-wrap bg-surface-base rounded px-2 py-1.5 max-h-48 overflow-auto">
                  {Object.entries(d().req_headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                </pre>
              </details>
              <Show when={d().req_body}>
                <details>
                  <summary class="text-12-semibold cursor-pointer mb-1">Request body</summary>
                  <pre class="text-11-mono whitespace-pre-wrap bg-surface-base rounded px-2 py-1.5 max-h-64 overflow-auto">
                    {d().req_body.slice(0, 8192)}
                  </pre>
                </details>
              </Show>
              <details open>
                <summary class="text-12-semibold cursor-pointer mb-1">
                  Response · {d().status} · {d().duration_ms} ms
                </summary>
                <pre class="text-11-mono whitespace-pre-wrap bg-surface-base rounded px-2 py-1.5 max-h-48 overflow-auto">
                  {Object.entries(d().resp_headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                </pre>
              </details>
              <Show when={d().resp_body}>
                <details>
                  <summary class="text-12-semibold cursor-pointer mb-1">Response body</summary>
                  <pre class="text-11-mono whitespace-pre-wrap bg-surface-base rounded px-2 py-1.5 max-h-96 overflow-auto">
                    {d().resp_body.slice(0, 16384)}
                  </pre>
                </details>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Intercept panel
// ---------------------------------------------------------------------------

function InterceptPanel(props: {
  pending: PendingItem[]
  selected: number | null
  onSelect: (id: number | null) => void
  api: () => ReturnType<typeof makeApi>
}) {
  const sel = createMemo(() => props.pending.find((p) => p.id === props.selected) ?? null)
  const [editMethod, setEditMethod] = createSignal<string>("")
  const [editHeaders, setEditHeaders] = createSignal<string>("")
  const [editBody, setEditBody] = createSignal<string>("")

  const seedEdit = (p: PendingItem) => {
    setEditMethod(p.method)
    setEditHeaders(
      Object.entries(p.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    )
    setEditBody(p.body)
  }

  const forward = async (id: number) => {
    try {
      await props.api().forwardPending(id)
      showToast({ variant: "success", title: `#${id} inoltrato` })
      props.onSelect(null)
    } catch (e) {
      showToast({ variant: "error", title: (e as Error).message })
    }
  }
  const drop = async (id: number) => {
    try {
      await props.api().dropPending(id)
      showToast({ variant: "success", title: `#${id} eliminato` })
      props.onSelect(null)
    } catch (e) {
      showToast({ variant: "error", title: (e as Error).message })
    }
  }
  const submitEdit = async (p: PendingItem) => {
    try {
      const headers: Record<string, string> = {}
      for (const line of editHeaders().split("\n")) {
        const idx = line.indexOf(":")
        if (idx <= 0) continue
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
      await props.api().editPending(p.id, {
        method: editMethod() || undefined,
        headers,
        body: editBody(),
      })
      showToast({ variant: "success", title: `#${p.id} editato e inoltrato` })
      props.onSelect(null)
    } catch (e) {
      showToast({ variant: "error", title: (e as Error).message })
    }
  }

  return (
    <>
      <div class="w-1/3 min-w-72 max-w-md flex flex-col border-r border-surface-weak">
        <div class="px-3 py-2 border-b border-surface-weak bg-surface-base text-12-semibold">
          Richieste in attesa ({props.pending.length})
        </div>
        <div class="flex-1 overflow-y-auto">
          <Show
            when={props.pending.length > 0}
            fallback={
              <div class="p-8 text-center text-12-regular text-text-weak">
                Nessuna richiesta in attesa. Attiva l'intercept e fai partire una richiesta.
              </div>
            }
          >
            <For each={props.pending}>
              {(p) => (
                <button
                  onClick={() => {
                    props.onSelect(p.id)
                    seedEdit(p)
                  }}
                  class="w-full text-left px-3 py-2 border-b border-surface-weak hover:bg-surface-raised-base-hover transition-colors"
                  classList={{ "bg-surface-raised-base-hover": props.selected === p.id }}
                >
                  <div class="flex items-center gap-2">
                    <span class="text-11-mono text-text-weak">#{p.id}</span>
                    <span class="text-11-mono text-text-strong w-12">{p.method}</span>
                    <span class="text-11-regular truncate">
                      {p.scheme}://{p.host}
                      {p.path}
                    </span>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
      <div class="flex-1 min-w-0 overflow-y-auto p-4">
        <Show
          when={sel()}
          fallback={
            <div class="text-center text-12-regular text-text-weak pt-12">
              Seleziona una richiesta per inoltrarla, eliminarla o editarla.
            </div>
          }
        >
          {(p) => (
            <div class="space-y-3 max-w-3xl">
              <div class="flex gap-2">
                <Button variant="primary" onClick={() => forward(p().id)}>
                  Forward
                </Button>
                <Button variant="secondary" onClick={() => drop(p().id)}>
                  Drop
                </Button>
                <Button variant="secondary" onClick={() => submitEdit(p())}>
                  Edit + Forward
                </Button>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <TextField type="text" label="Method" value={editMethod()} onChange={setEditMethod} />
                <TextField
                  type="text"
                  label="URL (read-only)"
                  value={`${p().scheme}://${p().host}${p().path}`}
                  onChange={() => {}}
                  disabled
                />
              </div>
              <div>
                <div class="text-12-semibold mb-1">Headers (Name: Value, una per riga)</div>
                <textarea
                  class="w-full bg-surface-base rounded px-2 py-1.5 text-11-mono min-h-32 font-mono"
                  value={editHeaders()}
                  onInput={(e) => setEditHeaders(e.currentTarget.value)}
                />
              </div>
              <div>
                <div class="text-12-semibold mb-1">Body</div>
                <textarea
                  class="w-full bg-surface-base rounded px-2 py-1.5 text-11-mono min-h-48 font-mono"
                  value={editBody()}
                  onInput={(e) => setEditBody(e.currentTarget.value)}
                />
              </div>
            </div>
          )}
        </Show>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Rules panel (match-and-replace)
// ---------------------------------------------------------------------------

function RulesPanel(props: { rules: RuleRow[]; api: () => ReturnType<typeof makeApi>; onChange: () => void }) {
  const [type, setType] = createSignal<"request" | "response">("request")
  const [scope, setScope] = createSignal<"header" | "body" | "url">("body")
  const [match, setMatch] = createSignal("")
  const [replace, setReplace] = createSignal("")
  const [description, setDescription] = createSignal("")

  const submit = async () => {
    if (!match()) {
      showToast({ variant: "error", title: "Match regex obbligatorio" })
      return
    }
    try {
      await props.api().addRule({ type: type(), scope: scope(), match: match(), replace: replace(), description: description() })
      setMatch("")
      setReplace("")
      setDescription("")
      props.onChange()
      showToast({ variant: "success", title: "Regola aggiunta" })
    } catch (e) {
      showToast({ variant: "error", title: (e as Error).message })
    }
  }

  return (
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <section class="bg-surface-base rounded p-3 space-y-2">
        <h3 class="text-12-semibold">Aggiungi regola Match &amp; Replace</h3>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-11-regular text-text-weak">Type</span>
            <select
              class="bg-surface-weak rounded px-2 py-1 text-12-regular"
              value={type()}
              onChange={(e) => setType(e.currentTarget.value as "request" | "response")}
            >
              <option value="request">request</option>
              <option value="response">response</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-11-regular text-text-weak">Scope</span>
            <select
              class="bg-surface-weak rounded px-2 py-1 text-12-regular"
              value={scope()}
              onChange={(e) => setScope(e.currentTarget.value as "header" | "body" | "url")}
            >
              <option value="body">body</option>
              <option value="header">header</option>
              <option value="url">url</option>
            </select>
          </label>
        </div>
        <TextField type="text" label="Match (regex)" value={match()} onChange={setMatch} />
        <TextField type="text" label="Replace" value={replace()} onChange={setReplace} />
        <TextField type="text" label="Descrizione (opzionale)" value={description()} onChange={setDescription} />
        <Button variant="primary" onClick={submit}>
          Aggiungi
        </Button>
      </section>

      <section>
        <h3 class="text-12-semibold mb-2">Regole attive ({props.rules.length})</h3>
        <Show
          when={props.rules.length > 0}
          fallback={<div class="text-12-regular text-text-weak">Nessuna regola.</div>}
        >
          <div class="space-y-1">
            <For each={props.rules}>
              {(r) => (
                <div class="flex items-center gap-2 px-3 py-2 bg-surface-base rounded">
                  <button
                    onClick={async () => {
                      await props.api().toggleRule(r.id)
                      props.onChange()
                    }}
                    class="text-11-mono shrink-0 size-3 rounded-full"
                    classList={{
                      "bg-icon-success-base": !!r.enabled,
                      "bg-surface-weak": !r.enabled,
                    }}
                    aria-label="Toggle"
                  />
                  <span class="text-11-mono text-text-weak shrink-0">#{r.id}</span>
                  <span class="text-11-mono shrink-0">
                    {r.type}/{r.scope}
                  </span>
                  <span class="text-11-mono text-text-strong truncate flex-1">
                    {r.match} → {r.replace}
                  </span>
                  <Show when={r.description}>
                    <span class="text-10-regular text-text-weak truncate">{r.description}</span>
                  </Show>
                  <IconButton
                    icon="circle-ban-sign"
                    variant="ghost"
                    onClick={async () => {
                      await props.api().deleteRule(r.id)
                      props.onChange()
                    }}
                    aria-label="Elimina"
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent collaboration panel
// ---------------------------------------------------------------------------

function AgentPanel(props: {
  selectedFlow: number | null
  flows: FlowSummary[]
  pending: PendingItem[]
  api: () => ReturnType<typeof makeApi>
  onNavigateToAgent: () => void
}) {
  const [intent, setIntent] = createSignal("Analizza questo flusso, evidenzia anomalie e suggerisci attacchi pertinenti.")
  const [includeBody, setIncludeBody] = createSignal(true)
  const [snippet, setSnippet] = createSignal("")

  const buildPrompt = async () => {
    if (!props.selectedFlow) {
      showToast({ variant: "error", title: "Seleziona prima un flusso nella tab Flussi" })
      return
    }
    try {
      const f = await props.api().flow(props.selectedFlow)
      const headers = Object.entries(f.req_headers)
        .slice(0, 30)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")
      const respHeaders = Object.entries(f.resp_headers)
        .slice(0, 20)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")
      const body = includeBody() ? f.req_body.slice(0, 2048) : ""
      const respSnippet = includeBody() ? f.resp_body.slice(0, 4096) : ""
      const prompt = [
        `Compito: ${intent()}`,
        ``,
        `Flow #${f.id} catturato dal proxy locale Burp Workspace.`,
        ``,
        `## Request`,
        `${f.method} ${f.scheme}://${f.host}${f.path}`,
        headers,
        body ? `\n${body}` : "",
        ``,
        `## Response (${f.status} · ${f.duration_ms} ms · ${f.resp_body_size} B · ${f.resp_content_type ?? "-"})`,
        respHeaders,
        respSnippet ? `\n${respSnippet}` : "",
        ``,
        `## Strumenti che puoi usare con burp_toolkit`,
        `- repeater: replay con varianti (\`from-flow ${f.id}\`)`,
        `- intruder: fuzzer con \`§…§\` placeholder`,
        `- scanner: passive (sicuro) o active (richiede --enable + autorizzazione)`,
        `- decoder/hackvertor: decode/encode catene`,
        `- engagement-notes: registra finding con severity + CWE`,
        `- csrf-poc: genera HTML PoC se l'endpoint è state-changing senza token`,
        `- collaborator: token OOB per testare SSRF / XXE / blind XSS`,
      ].join("\n")
      setSnippet(prompt)
      void navigator.clipboard.writeText(prompt)
      showToast({ variant: "success", title: "Prompt copiato negli appunti" })
    } catch (e) {
      showToast({ variant: "error", title: (e as Error).message })
    }
  }

  const buildPendingPrompt = async () => {
    const p = props.pending[0]
    if (!p) {
      showToast({ variant: "error", title: "Nessuna richiesta in attesa" })
      return
    }
    const prompt = [
      `Una richiesta è bloccata in intercept (id=${p.id}).`,
      `Method: ${p.method}`,
      `URL: ${p.scheme}://${p.host}${p.path}`,
      `Headers: ${JSON.stringify(p.headers, null, 2)}`,
      p.body ? `Body: ${p.body.slice(0, 1024)}` : "",
      ``,
      `Decidi se inoltrare, droppare o editare. Se editi:`,
      `  burp_toolkit{ subtool: "proxy", args: ["intercept-action", "${p.id}", "edit", "--method", "POST", "--header", "X: y", "--body", "..."] }`,
    ].join("\n")
    setSnippet(prompt)
    void navigator.clipboard.writeText(prompt)
    showToast({ variant: "success", title: "Prompt copiato" })
  }

  return (
    <div class="flex-1 overflow-y-auto p-4">
      <div class="max-w-3xl mx-auto space-y-4">
        <div class="bg-surface-base rounded p-4">
          <div class="flex items-center gap-2 mb-2">
            <Icon name="code-lines" class="size-5 text-icon-warning-base" />
            <h3 class="text-14-semibold">Collabora con l'agente AI</h3>
          </div>
          <p class="text-12-regular text-text-weak mb-4">
            Costruisci un prompt strutturato che fa riferimento al flusso selezionato (o all'intercept pendente) e passalo
            all'agente <code class="bg-surface-weak px-1 rounded">pentester</code>. L'agente avrà accesso al{" "}
            <code class="bg-surface-weak px-1 rounded">burp_toolkit</code> per replay, fuzz, scan, decode, ecc.
          </p>

          <div class="space-y-3">
            <TextField type="text" label="Intento (cosa vuoi che faccia l'agente)" value={intent()} onChange={setIntent} />
            <label class="flex items-center gap-2 text-12-regular">
              <input
                type="checkbox"
                checked={includeBody()}
                onInput={(e) => setIncludeBody(e.currentTarget.checked)}
              />
              Includi body request/response (max 6 KB)
            </label>
            <div class="flex flex-wrap gap-2">
              <Button variant="primary" onClick={buildPrompt} disabled={!props.selectedFlow}>
                Genera prompt dal flusso #{props.selectedFlow ?? "—"}
              </Button>
              <Button variant="secondary" onClick={buildPendingPrompt} disabled={props.pending.length === 0}>
                Prompt da intercept pendente ({props.pending.length})
              </Button>
              <Button variant="secondary" onClick={props.onNavigateToAgent}>
                Apri composer agente
              </Button>
            </div>
          </div>
        </div>

        <Show when={snippet()}>
          <div class="bg-surface-base rounded p-3">
            <div class="flex items-center justify-between mb-2">
              <h4 class="text-12-semibold">Anteprima prompt (già negli appunti)</h4>
              <Button
                size="small"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(snippet())
                  showToast({ variant: "success", title: "Copiato" })
                }}
              >
                Copia di nuovo
              </Button>
            </div>
            <pre class="text-11-mono whitespace-pre-wrap bg-surface-weak rounded p-2 max-h-96 overflow-auto">
              {snippet()}
            </pre>
          </div>
        </Show>

        <div class="bg-surface-base rounded p-3 space-y-2">
          <h4 class="text-12-semibold">Quick actions per l'agente</h4>
          <For
            each={[
              {
                label: "Scan passivo dei 200 flussi più recenti",
                prompt:
                  'Esegui burp_toolkit { subtool: "scanner", args: ["batch", "--limit", "200"], as_json: true } e ' +
                  "riassumi per categoria (CSP, cookies, error fingerprints, secrets) con priorità + flow id di riferimento.",
              },
              {
                label: "Fuzz parametri sul flusso selezionato",
                prompt:
                  `Per flow #${props.selectedFlow ?? "<id>"}: identifica parametri query/body, lancia burp_toolkit ` +
                  `{ subtool: "intruder", args: ["sniper", "--from-flow", "${props.selectedFlow ?? "<id>"}", ` +
                  `"--builtin", "xss-basic"] } e mostra solo le risposte con score top-5.`,
              },
              {
                label: "Mappa autorizzazioni con auth-matrix",
                prompt:
                  "Genera con burp_toolkit { subtool: \"auth-matrix\", args: [\"from-history\", \"--limit\", \"30\"] } " +
                  "una matrice; chiedimi i Cookie/header per ciascuna identità, poi esegui run con --baseline admin.",
              },
              {
                label: "Avvia un Collaborator e mintami un payload",
                prompt:
                  "Esegui burp_toolkit { subtool: \"collaborator\", args: [\"payload\", \"--type\", \"http\"], as_json: true }, " +
                  "poi suggerisci 5 payload SSRF / XXE / SSTI che usano l'URL appena generato.",
              },
            ]}
          >
            {(qa) => (
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(qa.prompt)
                  showToast({ variant: "success", title: "Prompt copiato" })
                }}
                class="w-full text-left p-2 rounded hover:bg-surface-raised-base-hover"
              >
                <div class="text-12-semibold">{qa.label}</div>
                <div class="text-11-regular text-text-weak truncate">{qa.prompt}</div>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
