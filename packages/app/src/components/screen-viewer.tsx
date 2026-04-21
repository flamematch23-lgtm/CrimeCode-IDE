import { Show, createEffect, createSignal, onCleanup } from "solid-js"

interface Props {
  stream: MediaStream | null
  fromName: string | null
  onClose: () => void
}

export function ScreenViewer(props: Props) {
  const [el, setEl] = createSignal<HTMLVideoElement>()
  const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement>()
  const [maximized, setMaximized] = createSignal(false)
  const [annotate, setAnnotate] = createSignal(false)
  const [color, setColor] = createSignal("#ff3b30")

  let drawing = false
  let last: { x: number; y: number } | null = null

  createEffect(() => {
    const v = el()
    const s = props.stream
    if (!v) return
    if (s && v.srcObject !== s) {
      v.srcObject = s
      void v.play().catch(() => {})
    }
    if (!s) v.srcObject = null
  })

  createEffect(() => {
    const c = canvasEl()
    const v = el()
    if (!c || !v) return
    const sync = () => {
      const r = v.getBoundingClientRect()
      c.width = r.width
      c.height = r.height
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(v)
    onCleanup(() => ro.disconnect())
  })

  function pos(e: MouseEvent) {
    const c = canvasEl()!
    const r = c.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function ripple(p: { x: number; y: number }) {
    const c = canvasEl()
    if (!c) return
    const ctx = c.getContext("2d")!
    let r = 4
    let alpha = 1
    const tick = () => {
      if (alpha <= 0) return
      ctx.save()
      ctx.beginPath()
      ctx.strokeStyle = color()
      ctx.globalAlpha = alpha
      ctx.lineWidth = 3
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
      r += 4
      alpha -= 0.06
      requestAnimationFrame(tick)
    }
    tick()
  }

  function down(e: MouseEvent) {
    if (!annotate()) {
      ripple(pos(e))
      return
    }
    drawing = true
    last = pos(e)
  }
  function move(e: MouseEvent) {
    if (!drawing || !annotate()) return
    const c = canvasEl()
    if (!c || !last) return
    const ctx = c.getContext("2d")!
    const p = pos(e)
    ctx.strokeStyle = color()
    ctx.lineWidth = 3
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last = p
  }
  function up() {
    drawing = false
    last = null
  }
  function clear() {
    const c = canvasEl()
    if (!c) return
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height)
  }

  return (
    <Show when={props.stream}>
      <div
        class={`fixed z-[900] bg-black rounded-lg shadow-2xl border border-border-base overflow-hidden flex flex-col ${
          maximized() ? "inset-4" : "right-4 bottom-4 w-[480px] h-[300px]"
        }`}
      >
        <div class="flex items-center justify-between bg-surface-weak px-2 py-1 text-xs gap-2">
          <span class="truncate">Screen from {props.fromName ?? "host"}</span>
          <div class="flex items-center gap-1">
            <button
              class={`px-2 ${annotate() ? "text-text-accent" : "text-text-secondary hover:text-text-base"}`}
              title="Toggle annotate"
              onClick={() => setAnnotate(!annotate())}
            >
              ✎
            </button>
            <input
              type="color"
              value={color()}
              onChange={(e) => setColor(e.currentTarget.value)}
              class="w-5 h-5 bg-transparent border-0 cursor-pointer"
              title="Color"
            />
            <button class="text-text-secondary hover:text-text-base px-2" title="Clear" onClick={clear}>
              ⌫
            </button>
            <button class="text-text-secondary hover:text-text-base px-2" onClick={() => setMaximized(!maximized())}>
              {maximized() ? "▢" : "⛶"}
            </button>
            <button class="text-text-critical hover:underline px-2" onClick={props.onClose}>
              ✕
            </button>
          </div>
        </div>
        <div class="flex-1 relative">
          <video
            ref={setEl}
            class="absolute inset-0 w-full h-full bg-black object-contain"
            autoplay
            playsinline
            muted
          />
          <canvas
            ref={setCanvasEl}
            class={`absolute inset-0 w-full h-full ${annotate() ? "cursor-crosshair" : "cursor-default"}`}
            onMouseDown={down}
            onMouseMove={move}
            onMouseUp={up}
            onMouseLeave={up}
          />
        </div>
      </div>
    </Show>
  )
}
