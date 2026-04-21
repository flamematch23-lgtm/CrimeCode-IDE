import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: any
    }
  }
}

export const [browserUrl, setBrowserUrl] = createSignal("")

export function BrowserPreview() {
  const [url, setUrl] = createSignal(browserUrl())
  const [input, setInput] = createSignal(browserUrl())
  const [loading, setLoading] = createSignal(false)
  let ref: any

  const navigate = (target?: string) => {
    const next = target ?? input()
    if (!next) return
    const full = next.startsWith("http") ? next : `https://${next}`
    setUrl(full)
    setInput(full)
  }

  // Listen for browser-preview-navigate events from main process
  onMount(() => {
    const api = (window as any).api
    if (api?.onBrowserPreviewNavigate) {
      const handler = (newUrl: string) => {
        if (newUrl) {
          setUrl(newUrl)
          setInput(newUrl)
        }
      }
      api.onBrowserPreviewNavigate(handler)
    }
  })

  // Sync external URL changes
  const check = setInterval(() => {
    const ext = browserUrl()
    if (ext && ext !== url()) {
      setUrl(ext)
      setInput(ext)
    }
  }, 500)
  onCleanup(() => clearInterval(check))

  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-1 px-2 py-1 border-b border-border-weaker-base bg-background-stronger">
        <IconButton
          icon="arrow-left"
          variant="ghost"
          class="h-6 w-6"
          onClick={() => ref?.goBack?.()}
          aria-label="Back"
        />
        <IconButton
          icon="arrow-right"
          variant="ghost"
          class="h-6 w-6"
          onClick={() => ref?.goForward?.()}
          aria-label="Forward"
        />
        <IconButton icon="reset" variant="ghost" class="h-6 w-6" onClick={() => ref?.reload?.()} aria-label="Reload" />
        <form
          class="flex-1 flex"
          onSubmit={(e) => {
            e.preventDefault()
            navigate()
          }}
        >
          <input
            type="text"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            class="flex-1 h-6 px-2 text-12-regular rounded bg-background-base border border-border-base text-text-base outline-none focus:border-text-weak"
            placeholder="Enter URL..."
          />
        </form>
        <Show when={loading()}>
          <div class="text-11-regular text-text-weak px-1">Loading...</div>
        </Show>
      </div>
      <div class="flex-1 min-h-0">
        <Show
          when={url()}
          fallback={
            <div class="h-full flex items-center justify-center text-14-regular text-text-weak">
              Enter a URL above to preview
            </div>
          }
        >
          <webview
            ref={(el: any) => {
              ref = el
              if (el) {
                el.addEventListener("did-start-loading", () => setLoading(true))
                el.addEventListener("did-stop-loading", () => setLoading(false))
                el.addEventListener("did-navigate", (e: any) => setInput(e.url))
                el.addEventListener("did-navigate-in-page", (e: any) => {
                  if (e.isMainFrame) setInput(e.url)
                })
              }
            }}
            src={url()}
            style="width:100%;height:100%"
            allowpopups
          />
        </Show>
      </div>
    </div>
  )
}
