import { For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

type Entry = {
  id: number
  at: number
  kind: "error" | "unhandledrejection" | "console" | "fetch" | "sse"
  message: string
  stack?: string
  source?: string
  route?: string
  count: number
}

let counter = 0

const NOISE = [/ResizeObserver loop/i, /^Script error\.?$/i, /Non-Error promise rejection captured/i]

function noisy(message: string): boolean {
  return NOISE.some((re) => re.test(message))
}

function format(value: unknown): { message: string; stack?: string } {
  if (value === null || value === undefined) return { message: String(value) }
  if (value instanceof Error || (typeof value === "object" && value && "name" in value && "message" in value)) {
    const v = value as { name?: string; message?: string; stack?: string; code?: number | string }
    const code = v.code !== undefined ? ` (code=${v.code})` : ""
    return { message: `${v.name ?? "Error"}: ${v.message ?? ""}${code}`, stack: v.stack }
  }
  if (typeof value === "string") return { message: value }
  try {
    return { message: JSON.stringify(value, null, 2) }
  } catch {
    return { message: String(value) }
  }
}

export function DiagnosticOverlay() {
  const [state, setState] = createStore({
    open: false,
    entries: [] as Entry[],
  })

  const push = (entry: Omit<Entry, "id" | "at" | "route" | "count">) => {
    if (noisy(entry.message)) return
    setState("entries", (prev) => {
      const last = prev[prev.length - 1]
      if (last && last.kind === entry.kind && last.message === entry.message) {
        const updated = { ...last, count: last.count + 1, at: Date.now() }
        return [...prev.slice(0, -1), updated]
      }
      counter += 1
      const next = [
        ...prev,
        {
          ...entry,
          id: counter,
          at: Date.now(),
          route: window.location.pathname + window.location.search,
          count: 1,
        },
      ]
      return next.length > 50 ? next.slice(-50) : next
    })
  }

  onMount(() => {
    const onError = (ev: ErrorEvent) => {
      const fmt = format(ev.error ?? ev.message)
      push({
        kind: "error",
        message: fmt.message,
        stack: fmt.stack,
        source: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
      })
    }
    const onRejection = (ev: PromiseRejectionEvent) => {
      const fmt = format(ev.reason)
      push({ kind: "unhandledrejection", message: fmt.message, stack: fmt.stack })
    }
    const origError = console.error.bind(console)
    const onConsoleError = (...args: unknown[]) => {
      origError(...args)
      const first = args[0]
      const fmt = format(first)
      const rest =
        args.length > 1
          ? args
              .slice(1)
              .map((a) => format(a).message)
              .join(" ")
          : ""
      push({
        kind: "console",
        message: rest ? `${fmt.message} ${rest}` : fmt.message,
        stack: fmt.stack,
      })
    }

    // wrap fetch to capture failed requests with URL/method/status
    const origFetch = window.fetch.bind(window)
    /**
     * Self-healing paths we intentionally suppress from the diagnostic feed.
     * The app recovers from these automatically (clone/retry), so surfacing
     * them creates scary counts of "errors" that aren't actionable for the
     * user. If these start returning OTHER statuses (500, 403) they'll fall
     * through and be recorded normally.
     */
    const isExpected404 = (method: string, url: string, status: number): boolean => {
      if (status !== 404) return false
      if (method !== "GET" && method !== "DELETE") return false
      // /pty/pty_<id>... — the client prunes stale IDs via the clone flow.
      if (/\/pty\/pty_[A-Za-z0-9]+(\?|$)/.test(url)) return true
      return false
    }
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const startedAt = performance.now()
      try {
        const res = await origFetch(input as RequestInfo, init)
        if (!res.ok && !isExpected404(method, url, res.status)) {
          push({
            kind: "fetch",
            message: `${method} ${url} → ${res.status} ${res.statusText}`,
            source: `${Math.round(performance.now() - startedAt)}ms`,
          })
        }
        return res
      } catch (err) {
        const fmt = format(err)
        push({
          kind: "fetch",
          message: `${method} ${url} FAILED: ${fmt.message}`,
          stack: fmt.stack,
          source: `${Math.round(performance.now() - startedAt)}ms`,
        })
        throw err
      }
    }) as typeof fetch
    window.fetch = wrappedFetch

    // wrap EventSource constructor to capture SSE failures
    const OrigES = window.EventSource
    let wrappedES: typeof EventSource | undefined
    if (OrigES) {
      class TracedES extends OrigES {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          const href = typeof url === "string" ? url : url.href
          this.addEventListener("error", () => {
            push({
              kind: "sse",
              message: `EventSource error ${href} (readyState=${this.readyState})`,
            })
          })
        }
      }
      wrappedES = TracedES as typeof EventSource
      window.EventSource = wrappedES
    }

    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    console.error = onConsoleError as typeof console.error
    onCleanup(() => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
      console.error = origError
      window.fetch = origFetch
      if (OrigES && window.EventSource === wrappedES) window.EventSource = OrigES
    })
  })

  const count = createMemo(() => state.entries.length)

  const copyAll = () => {
    const text = state.entries
      .map((e) => {
        const lines = [
          `[${new Date(e.at).toISOString()}] ${e.kind.toUpperCase()}${e.count > 1 ? ` × ${e.count}` : ""}`,
          e.route ? `route: ${e.route}` : undefined,
          e.source ? `at ${e.source}` : undefined,
          e.message,
          e.stack,
        ].filter(Boolean)
        return lines.join("\n")
      })
      .join("\n\n" + "─".repeat(40) + "\n\n")
    const payload = [
      `OpenCode Diagnostic Report`,
      `URL: ${window.location.href}`,
      `UA: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`,
      "",
      text || "(no errors captured)",
    ].join("\n")
    void navigator.clipboard.writeText(payload).catch(() => {})
  }

  const clear = () => setState("entries", [])

  return (
    <Show when={count() > 0}>
      <div
        style={{
          position: "fixed",
          bottom: "12px",
          right: "12px",
          "z-index": "999999",
          "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
          "font-size": "12px",
        }}
      >
        <Show
          when={state.open}
          fallback={
            <button
              type="button"
              onClick={() => setState("open", true)}
              style={{
                background: "#dc2626",
                color: "white",
                border: "none",
                padding: "8px 12px",
                "border-radius": "8px",
                cursor: "pointer",
                "box-shadow": "0 4px 12px rgba(0,0,0,0.3)",
                "font-weight": "600",
              }}
            >
              ⚠ {count()} error{count() === 1 ? "" : "s"}
            </button>
          }
        >
          <div
            style={{
              background: "#1f2937",
              color: "#f9fafb",
              border: "1px solid #dc2626",
              "border-radius": "8px",
              padding: "12px",
              width: "min(560px, calc(100vw - 24px))",
              "max-height": "min(60vh, 480px)",
              display: "flex",
              "flex-direction": "column",
              gap: "8px",
              "box-shadow": "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
              <strong style={{ color: "#fca5a5" }}>Diagnostic ({count()})</strong>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={copyAll}
                  style={{
                    background: "#374151",
                    color: "white",
                    border: "none",
                    padding: "4px 10px",
                    "border-radius": "4px",
                    cursor: "pointer",
                  }}
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={clear}
                  style={{
                    background: "#374151",
                    color: "white",
                    border: "none",
                    padding: "4px 10px",
                    "border-radius": "4px",
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setState("open", false)}
                  style={{
                    background: "#374151",
                    color: "white",
                    border: "none",
                    padding: "4px 10px",
                    "border-radius": "4px",
                    cursor: "pointer",
                  }}
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ "font-size": "10px", opacity: "0.7", "word-break": "break-all" }}>
              {window.location.pathname}
            </div>
            <div style={{ overflow: "auto", flex: "1", "min-height": "0" }}>
              <For each={state.entries.slice().reverse()}>
                {(entry) => (
                  <div
                    style={{
                      "border-bottom": "1px solid #374151",
                      padding: "6px 0",
                      "white-space": "pre-wrap",
                      "word-break": "break-word",
                    }}
                  >
                    <div style={{ color: "#fca5a5", "font-weight": "600" }}>
                      [{entry.kind}]{entry.count > 1 ? ` × ${entry.count}` : ""} {entry.source ?? ""}
                    </div>
                    <div>{entry.message}</div>
                    <Show when={entry.stack}>
                      {(stack) => (
                        <div style={{ opacity: "0.7", "font-size": "11px", "margin-top": "4px" }}>{stack()}</div>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
