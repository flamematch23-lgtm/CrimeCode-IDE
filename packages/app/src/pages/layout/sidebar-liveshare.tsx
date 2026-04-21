import { Show, type Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { useLiveShareState } from "@/context/liveshare-state"

const DIR = "@liveshare"

export const LiveShareSidebarItem = (props: { selected: Accessor<boolean>; mobile?: boolean }) => {
  const liveshare = useLiveShareState()
  const navigate = useNavigate()
  const placement = () => (props.mobile ? "bottom" : "right")

  const label = () => {
    const role = liveshare.state.role
    const tag = role ? ` (${role})` : ""
    const count = liveshare.state.participants
    return `Live Share${tag}${count ? ` — ${count} connected` : ""}`
  }

  const open = () => {
    const target = liveshare.state.hostSession
    const dir = base64Encode(DIR)
    navigate(target ? `/${dir}/session/${target}` : `/${dir}/session`)
  }

  return (
    <Tooltip placement={placement()} value={label()}>
      <button
        type="button"
        aria-label={label()}
        data-action="liveshare-switch"
        onClick={open}
        classList={{
          "flex items-center justify-center size-10 p-1 rounded-lg overflow-hidden transition-colors cursor-default": true,
          "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover": props.selected(),
          "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base":
            !props.selected(),
        }}
      >
        <Icon name="share" />
        <Show when={liveshare.state.participants > 0}>
          <span class="absolute -mt-6 -mr-6 text-10-medium bg-fill-accent text-text-on-accent rounded-full px-1">
            {liveshare.state.participants}
          </span>
        </Show>
      </button>
    </Tooltip>
  )
}
