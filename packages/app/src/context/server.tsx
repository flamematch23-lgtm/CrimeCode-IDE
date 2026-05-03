import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useCheckServerHealth } from "@/utils/server-health"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
// Era 10_000. Aumentato a 30s perché un refresh ogni 10s era aggressivo:
// quando il valore cambia, triggera re-render dell'intera UI che leggeva
// state.healthy (es. session timeline). 30s è abbastanza per mostrare uno
// stato "down" entro tempo ragionevole senza spammare re-render.
const HEALTH_POLL_INTERVAL_MS = 30_000

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return

  // Map WebSocket schemes to HTTP — the health check is a regular HTTP GET.
  // Any other unknown scheme is rejected (we only do http(s)). This prevents
  // the previous bug where `wss://host` became `http://wss://host`, which
  // browsers normalise to `http://wss//host/...` and blasts requests at a
  // host literally called `wss`.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)
  let withProtocol: string
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    const rest = trimmed.slice(schemeMatch[0].length)
    if (scheme === "http" || scheme === "https") withProtocol = `${scheme}://${rest}`
    else if (scheme === "ws") withProtocol = `http://${rest}`
    else if (scheme === "wss") withProtocol = `https://${rest}`
    else return // unknown scheme — refuse so we don't fetch a malformed URL
  } else {
    // Bare schemes like "h", "ht", "htt", "http", "https" while the user is
    // still typing — short-circuit so we don't fire fetches at hosts named
    // "h" or "ht".
    if (/^https?$/i.test(trimmed)) return
    if (/^wss?$/i.test(trimmed)) return
    if (trimmed.includes("//") && !/[.:]/.test(trimmed.split("//")[0] ?? "")) {
      // Pasted "://something" or "//something" — wait for the host part to
      // become valid before issuing requests.
      return
    }
    withProtocol = `http://${trimmed}`
  }

  // Validate that the result parses to a real URL with a non-empty host.
  // If it doesn't, abort: callers will treat a missing return value as
  // "input not yet complete enough to fetch".
  try {
    const u = new URL(withProtocol)
    if (!u.hostname) return
    // Reject hostnames that contain stray slashes — these are scheme
    // remnants the regex above may have failed to strip. We DO allow
    // colons in hostnames to keep IPv6 working (`[::1]`, `[2001:…]`):
    // the URL parser already rejects truly malformed colons before we
    // get here, so any colon that survives is a legitimate IPv6 byte.
    if (u.hostname.includes("/")) return
    // Reject scheme-leftovers like `wss:` or `ws:` that the URL parser
    // sometimes accepts as a "host" when followed by garbage. IPv6 is
    // bracketed (`[...]`) so it never matches this guard.
    if (!u.hostname.startsWith("[") && /[a-z]+:$/i.test(u.hostname)) return
  } catch {
    return
  }
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(key: ServerConnection.Key) {
  if (!key) return ""
  if (key === "sidecar") return "local"
  if (isLocalHost(key)) return "local"
  return key
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultServer: ServerConnection.Key; servers?: Array<ServerConnection.Any> }) => {
    const checkServerHealth = useCheckServerHealth()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      const servers = [
        ...(props.servers ?? []),
        ...store.list.map((value) =>
          typeof value === "string"
            ? {
                type: "http" as const,
                http: { url: value },
              }
            : value,
        ),
      ]

      const deduped = new Map(
        servers.map((value) => {
          const conn: ServerConnection.Any = "type" in value ? value : { type: "http", http: value }
          return [ServerConnection.key(conn), conn]
        }),
      )

      return [...deduped.values()]
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
      healthy: undefined as boolean | undefined,
    })

    const healthy = () => state.healthy

    function startHealthPolling(conn: ServerConnection.Any) {
      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(conn)
          .then((next) => {
            if (!alive) return
            // BUG-FIX (refresh 10s scroll reset): no-op se stato invariato.
            // setState scatena re-render anche se il valore è identico, e
            // questo faceva rimontare la session timeline ogni 10s perdendo
            // la posizione di scroll dell'utente.
            if (state.healthy === next) return
            setState("healthy", next)
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, HEALTH_POLL_INTERVAL_MS)
      return () => {
        alive = false
        clearInterval(interval)
      }
    }

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn = { ...input, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) {
          const next = list[0]
          setState("active", next ? ServerConnection.Key.make(url(next)) : props.defaultServer)
        }
      })
    }

    const isReady = createMemo(() => ready() && !!state.active)

    const check = (conn: ServerConnection.Any) => checkServerHealth(conn.http).then((x) => x.healthy)

    createEffect(() => {
      const current_ = current()
      if (!current_) return

      setState("healthy", undefined)
      onCleanup(startHealthPolling(current_))
    })

    const origin = createMemo(() => projectsKey(state.active))
    const projectsList = createMemo(() => store.projects[origin()] ?? [])
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => {
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || (c?.type === "http" && isLocalHost(c.http.url))
    })

    return {
      ready: isReady,
      healthy,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
