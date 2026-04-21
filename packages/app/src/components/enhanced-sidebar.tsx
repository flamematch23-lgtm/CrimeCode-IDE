import { createSignal, For, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"

interface QuickAction {
  id: string
  label: string
  icon: string
  shortcut?: string
  category: "file" | "tool" | "view" | "help"
}

const QUICK_ACTIONS: QuickAction[] = [
  { id: "new-session", label: "New Session", icon: "➕", category: "file", shortcut: "Ctrl+N" },
  { id: "open-file", label: "Open File", icon: "📂", category: "file", shortcut: "Ctrl+O" },
  { id: "save", label: "Save", icon: "💾", category: "file", shortcut: "Ctrl+S" },
  { id: "screenshot", label: "Screenshot", icon: "📸", category: "tool", shortcut: "Ctrl+Shift+S" },
  { id: "tools", label: "Tools Menu", icon: "🔧", category: "view" },
  { id: "settings", label: "Settings", icon: "⚙️", category: "view", shortcut: "Ctrl+," },
  { id: "help", label: "Help", icon: "❓", category: "help" },
  { id: "feedback", label: "Send Feedback", icon: "💬", category: "help" },
]

interface SidebarCategory {
  name: string
  icon: string
  items: QuickAction[]
  isExpanded: boolean
}

export function EnhancedSidebar() {
  const [selectedAction, setSelectedAction] = createSignal<string | null>(null)
  const [expandedCategories, setExpandedCategories] = createSignal<Record<string, boolean>>({})

  const getCategories = (): SidebarCategory[] => {
    const categoryMap: Record<string, { name: string; icon: string }> = {}

    return Object.entries(categoryMap).map(([key, { name, icon }]) => ({
      name,
      icon,
      items: QUICK_ACTIONS.filter((a) => a.category === key),
      isExpanded: expandedCategories()[key] ?? true,
    }))
  }

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [category]: !prev[category],
    }))
  }

  return (
    <div class="w-64 h-full bg-surface-base border-r border-surface-weak flex flex-col overflow-hidden">
      {/* Header */}
      <div class="px-4 py-4 border-b border-surface-weak bg-surface-weak/50">
        <h2 class="text-14-semibold text-text-strong">Quick Actions</h2>
        <p class="text-11-regular text-text-subtle mt-1">Frequently used commands</p>
      </div>

      {/* Sidebar Content */}
      <div class="flex-1 overflow-y-auto">
        <For each={getCategories()}>
          {(category) => (
            <div class="border-b border-surface-weak/50">
              {/* Category Header */}
              <button
                onclick={() => toggleCategory(category.name.toLowerCase())}
                class="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-weak/50 transition-colors text-11-semibold text-text-secondary uppercase tracking-wider"
              >
                <div class="flex items-center gap-2">
                  <span class="text-14">{category.icon}</span>
                  <span>{category.name}</span>
                </div>
                <span class={`transition-transform ${category.isExpanded ? "rotate-180" : ""}`}>▼</span>
              </button>

              {/* Category Items */}
              <Show when={category.isExpanded}>
                <div class="px-2 py-1">
                  <For each={category.items}>
                    {(action) => (
                      <Tooltip value={action.label}>
                        <button
                          onclick={() => setSelectedAction(action.id)}
                          class={`w-full flex items-center justify-between px-3 py-2 rounded mx-0 mb-1 transition-all ${
                            selectedAction() === action.id
                              ? "bg-icon-warning-base/20 border border-icon-warning-base text-text-strong"
                              : "hover:bg-surface-weak text-text-secondary hover:text-text-strong"
                          }`}
                        >
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="text-16 flex-shrink-0">{action.icon}</span>
                            <span class="text-11-regular truncate">{action.label}</span>
                          </div>
                          <Show when={action.shortcut}>
                            <span class="text-10-regular text-text-subtle bg-surface-weak px-1.5 py-0.5 rounded flex-shrink-0 ml-2">
                              {action.shortcut}
                            </span>
                          </Show>
                        </button>
                      </Tooltip>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      {/* Footer */}
      <div class="px-4 py-3 border-t border-surface-weak bg-surface-weak/50 flex items-center justify-between">
        <span class="text-11-regular text-text-subtle">v1.0.0</span>
        <div class="flex items-center gap-1">
          <Tooltip value="Settings">
            <button class="text-16 hover:bg-surface-weak p-1.5 rounded transition-colors">⚙️</button>
          </Tooltip>
          <Tooltip value="Notifications">
            <button class="text-16 hover:bg-surface-weak p-1.5 rounded transition-colors">🔔</button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
