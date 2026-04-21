import { Button } from "@opencode-ai/ui/button"
import { createSignal, For, onMount, Show } from "solid-js"
import type { Quality } from "../utils/screen-share"

export interface ScreenSource {
  id: string
  name: string
  type: "screen" | "window"
  thumbnail: string
  appIcon: string | null
}

export interface ScreenPick {
  source: ScreenSource
  quality: Quality
  audio: boolean
  fps: number
}

interface Props {
  open: boolean
  onPick: (p: ScreenPick) => void
  onClose: () => void
}

export function ScreenSourcePicker(props: Props) {
  const [sources, setSources] = createSignal<ScreenSource[]>([])
  const [loading, setLoading] = createSignal(false)
  const [filter, setFilter] = createSignal<"all" | "screen" | "window">("all")
  const [quality, setQuality] = createSignal<Quality>("1080p")
  const [audio, setAudio] = createSignal(false)
  const [fps, setFps] = createSignal(30)

  async function refresh() {
    if (!window.api?.getScreenSources) return
    setLoading(true)
    try {
      const list = await window.api.getScreenSources({
        types: ["screen", "window"],
        thumbnail: { width: 320, height: 180 },
      })
      setSources(list)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    if (props.open) refresh()
  })

  const filtered = () => {
    const f = filter()
    if (f === "all") return sources()
    return sources().filter((s) => s.type === f)
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
        onClick={(e) => {
          if (e.currentTarget === e.target) props.onClose()
        }}
      >
        <div class="bg-background-base border border-border-base rounded-lg shadow-xl w-[720px] max-h-[80vh] flex flex-col">
          <div class="flex items-center justify-between p-4 border-b border-border-base">
            <div class="text-base font-medium">Choose what to share</div>
            <div class="flex gap-2">
              <button
                class={`text-xs px-2 py-1 rounded ${filter() === "all" ? "bg-fill-accent text-text-on-accent" : "text-text-secondary hover:bg-fill-hover"}`}
                onClick={() => setFilter("all")}
              >
                All
              </button>
              <button
                class={`text-xs px-2 py-1 rounded ${filter() === "screen" ? "bg-fill-accent text-text-on-accent" : "text-text-secondary hover:bg-fill-hover"}`}
                onClick={() => setFilter("screen")}
              >
                Screens
              </button>
              <button
                class={`text-xs px-2 py-1 rounded ${filter() === "window" ? "bg-fill-accent text-text-on-accent" : "text-text-secondary hover:bg-fill-hover"}`}
                onClick={() => setFilter("window")}
              >
                Windows
              </button>
              <Button variant="ghost" size="small" onClick={refresh}>
                {loading() ? "..." : "Refresh"}
              </Button>
            </div>
          </div>
          <div class="overflow-y-auto p-3 grid grid-cols-3 gap-3">
            <Show when={!loading() && filtered().length === 0}>
              <div class="col-span-3 text-center text-text-dimmed text-sm py-8">No sources</div>
            </Show>
            <For each={filtered()}>
              {(s) => (
                <button
                  class="flex flex-col gap-1 rounded border border-border-base p-2 hover:border-border-focus hover:bg-fill-hover text-left"
                  onClick={() => props.onPick({ source: s, quality: quality(), audio: audio(), fps: fps() })}
                >
                  <img src={s.thumbnail} alt={s.name} class="w-full h-28 object-contain bg-black/40 rounded" />
                  <div class="flex items-center gap-1.5">
                    <Show when={s.appIcon}>
                      <img src={s.appIcon!} class="w-4 h-4" alt="" />
                    </Show>
                    <span class="text-xs truncate">{s.name}</span>
                  </div>
                </button>
              )}
            </For>
          </div>
          <div class="flex items-center justify-between gap-3 p-3 border-t border-border-base">
            <div class="flex items-center gap-3 text-xs text-text-secondary">
              <label class="flex items-center gap-1">
                <span>Quality</span>
                <select
                  class="bg-fill-base border border-border-base rounded px-1 py-0.5"
                  value={quality()}
                  onChange={(e) => setQuality(e.currentTarget.value as Quality)}
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                  <option value="4k">4K</option>
                </select>
              </label>
              <label class="flex items-center gap-1">
                <span>FPS</span>
                <select
                  class="bg-fill-base border border-border-base rounded px-1 py-0.5"
                  value={fps()}
                  onChange={(e) => setFps(Number(e.currentTarget.value))}
                >
                  <option value="15">15</option>
                  <option value="30">30</option>
                  <option value="60">60</option>
                </select>
              </label>
              <label class="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={audio()} onChange={(e) => setAudio(e.currentTarget.checked)} />
                <span>Audio</span>
              </label>
            </div>
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </Show>
  )
}
