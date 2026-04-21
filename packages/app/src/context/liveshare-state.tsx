import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { Role } from "@/utils/live-share-socket"

export type LiveShareState = {
  active: boolean
  code: string
  role: Role | null
  hostSession: string | null
  participants: number
}

export const { use: useLiveShareState, provider: LiveShareStateProvider } = createSimpleContext({
  name: "LiveShareState",
  init: () => {
    const [state, set] = createStore<LiveShareState>({
      active: false,
      code: "",
      role: null,
      hostSession: null,
      participants: 0,
    })

    return {
      state,
      activate(opts: { code: string; role: Role | null; hostSession: string | null; participants: number }) {
        set({ active: true, ...opts })
      },
      deactivate() {
        set({ active: false, code: "", role: null, hostSession: null, participants: 0 })
      },
      setRole(role: Role | null) {
        set("role", role)
      },
      setHostSession(id: string | null) {
        set("hostSession", id)
      },
      setParticipants(n: number) {
        set("participants", n)
      },
    }
  },
})
