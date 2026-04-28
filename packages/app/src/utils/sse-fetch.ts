/**
 * Authorization-header friendly SSE consumer. EventSource cannot send custom
 * headers (so it's stuck with `?access_token=` in the URL — token leakage in
 * logs and history); fetch + ReadableStream lets us send a normal Bearer
 * header and parse the SSE wire format ourselves.
 *
 * The returned handle exposes a single `close()` method. Reconnect logic
 * (exponential backoff with jitter) is built in: a transient network drop
 * looks transparent to the caller. A 401/403 response from the server is
 * surfaced via `onError` and not retried, since retrying an auth failure
 * just hammers the endpoint.
 */

export interface SSEEvent {
  /** The `event:` field, or undefined when the server omitted it. */
  event?: string
  /** The `data:` field, joined with newlines if multiple were sent. */
  data: string
  /** The `id:` field, last one wins. */
  id?: string
}

export interface SSEFetchOpts {
  url: string
  /** Body for POST. Pass `null` for GET. */
  body?: BodyInit | null
  method?: "GET" | "POST"
  headers?: Record<string, string>
  onEvent: (e: SSEEvent) => void
  /** Called once per attempt the moment the response headers arrive (200). */
  onOpen?: () => void
  /** Called on hard failures (auth, malformed stream, exhausted retries). */
  onError?: (err: Error) => void
  /** Override reconnect base delay (ms). Default 500. */
  baseDelay?: number
  /** Max retries before giving up. Default Infinity (keep trying). */
  maxRetries?: number
}

export interface SSEHandle {
  close: () => void
}

const RECONNECT_CAP_MS = 30_000

export function sseFetch(opts: SSEFetchOpts): SSEHandle {
  const base = opts.baseDelay ?? 500
  const maxRetries = opts.maxRetries ?? Number.POSITIVE_INFINITY
  const method = opts.method ?? (opts.body == null ? "GET" : "POST")

  const ctrl = new AbortController()
  let stopped = false
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleReconnect() {
    if (stopped) return
    retries += 1
    if (retries > maxRetries) {
      opts.onError?.(new Error("SSE max retries exceeded"))
      return
    }
    const delay = Math.min(base * 2 ** Math.min(retries - 1, 8), RECONNECT_CAP_MS) + Math.random() * 250
    timer = setTimeout(() => {
      timer = null
      void connect()
    }, delay)
  }

  async function connect() {
    if (stopped) return
    try {
      const res = await fetch(opts.url, {
        method,
        headers: { Accept: "text/event-stream", ...opts.headers },
        body: opts.body ?? null,
        signal: ctrl.signal,
      })
      // Auth / authorization failures are terminal — retrying just spams.
      if (res.status === 401 || res.status === 403) {
        opts.onError?.(new Error(`SSE auth failed: HTTP ${res.status}`))
        stopped = true
        return
      }
      if (!res.ok || !res.body) {
        scheduleReconnect()
        return
      }
      retries = 0
      opts.onOpen?.()
      await readStream(res.body, opts.onEvent)
      // Stream ended cleanly — try to reconnect (server may have rotated).
      if (!stopped) scheduleReconnect()
    } catch (err) {
      if (stopped) return
      // AbortError shows up when close() is called; nothing to do.
      if ((err as { name?: string })?.name === "AbortError") return
      scheduleReconnect()
    }
  }

  void connect()

  return {
    close() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try {
        ctrl.abort()
      } catch {
        /* ignore */
      }
    },
  }
}

async function readStream(body: ReadableStream<Uint8Array>, onEvent: (e: SSEEvent) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    // SSE separates events with a blank line (\n\n). Each event is a
    // sequence of `field: value\n` lines.
    let sep
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const evt = parseBlock(block)
      if (evt) onEvent(evt)
    }
  }
}

function parseBlock(block: string): SSEEvent | null {
  let event: string | undefined
  let id: string | undefined
  const data: string[] = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.startsWith("\r") ? rawLine.slice(1) : rawLine
    if (!line || line.startsWith(":")) continue // comment / heartbeat
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line[colon + 1] === " " ? line.slice(colon + 2) : line.slice(colon + 1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
    else if (field === "id") id = value
    // retry: ignored — we manage backoff ourselves.
  }
  if (data.length === 0 && !event) return null
  return { event, data: data.join("\n"), id }
}
