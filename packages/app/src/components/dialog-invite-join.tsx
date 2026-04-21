import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useCheckServerHealth } from "@/utils/server-health"
import { useDialog } from "@opencode-ai/ui/context/dialog"

const DEFAULT_RELAY = "http://localhost:3747"

export function DialogInviteJoin() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const server = useServer()
  const language = useLanguage()
  const checkHealth = useCheckServerHealth()

  const [store, setStore] = createStore({
    code: "",
    relay: DEFAULT_RELAY,
    error: "",
    busy: false,
  })

  const reset = () => {
    setStore({ code: "", relay: DEFAULT_RELAY, error: "", busy: false })
  }

  const submit = async () => {
    if (store.busy) return
    if (!store.code.trim() || !store.relay.trim()) {
      setStore("error", language.t("dialog.invite.error"))
      return
    }

    setStore("busy", true)
    setStore("error", "")

    try {
      let relayUrl = store.relay.trim()

      // Handle cases where user pastes the full WebSocket connection string
      try {
        const u = new URL(relayUrl)
        if (u.protocol === "wss:") u.protocol = "https:"
        if (u.protocol === "ws:") u.protocol = "http:"
        // Only strip search and pathname if they pasted a connection string with a code query param
        if (u.searchParams.has("code")) {
          u.search = ""
          u.pathname = ""
        }
        relayUrl = u.toString().replace(/\/+$/, "")
      } catch {
        relayUrl = relayUrl.replace(/\/+$/, "")
      }

      const code = store.code.toUpperCase().trim()
      const res = await fetch(`${relayUrl}/invite/${code}`, {
        headers: { "ngrok-skip-browser-warning": "1" },
      })
      if (!res.ok) {
        setStore("error", language.t("dialog.invite.error"))
        setStore("busy", false)
        return
      }

      const data = (await res.json()) as { url: string; token?: string }
      const url = normalizeServerUrl(data.url)
      if (!url) {
        setStore("error", language.t("dialog.invite.error"))
        setStore("busy", false)
        return
      }

      const http: ServerConnection.HttpBase = { url }
      if (data.token) {
        http.username = "opencode"
        http.password = data.token
      }

      const health = await checkHealth(http)
      if (!health.healthy) {
        setStore("error", language.t("dialog.server.add.error"))
        setStore("busy", false)
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        displayName: `Invite ${code}`,
        http,
      }

      server.add(conn)
      showToast({
        variant: "success",
        title: language.t("dialog.invite.success"),
      })
      reset()
      dialog.close()
      navigate("/")
    } catch (e) {
      setStore("error", language.t("dialog.invite.error"))
      setStore("busy", false)
    }
  }

  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <Dialog title={language.t("dialog.invite.title")}>
      <div class="flex flex-col gap-2">
        <div class="px-5">
          <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
            <TextField
              type="text"
              label={language.t("dialog.invite.code")}
              placeholder={language.t("dialog.invite.codePlaceholder")}
              value={store.code}
              autofocus
              validationState={store.error ? "invalid" : "valid"}
              error={store.error}
              disabled={store.busy}
              onChange={(v) => setStore({ code: v, error: "" })}
              onKeyDown={keyDown}
            />
            <TextField
              type="text"
              label={language.t("dialog.invite.relay")}
              placeholder={language.t("dialog.invite.relayPlaceholder")}
              value={store.relay}
              disabled={store.busy}
              onChange={(v) => setStore({ relay: v, error: "" })}
              onKeyDown={keyDown}
            />
          </div>
        </div>
        <div class="px-5 pb-5">
          <Button variant="primary" size="large" onClick={submit} disabled={store.busy} class="px-3 py-1.5">
            {store.busy ? language.t("dialog.invite.joining") : language.t("dialog.invite.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
