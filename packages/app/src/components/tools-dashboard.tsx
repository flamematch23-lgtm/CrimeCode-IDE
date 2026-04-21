import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"

interface Tool {
  id: string
  name: string
  description: string
  icon: string
  category: "security" | "networking" | "analysis" | "encoding"
  shortcut?: string
}

const CYBERSECURITY_TOOLS: Tool[] = [
  {
    id: "screenshot",
    name: "Screenshot",
    description: "Capture screen content",
    icon: "📸",
    category: "analysis",
    shortcut: "Ctrl+Shift+S",
  },
  {
    id: "port-scanner",
    name: "Port Scanner",
    description: "Scan network ports",
    icon: "🔍",
    category: "networking",
  },
  {
    id: "ssl-checker",
    name: "SSL Certificate",
    description: "Check SSL/TLS certificates",
    icon: "🔐",
    category: "security",
  },
  {
    id: "dns-lookup",
    name: "DNS Lookup",
    description: "Query DNS records",
    icon: "🌐",
    category: "networking",
  },
  {
    id: "hash",
    name: "Hash Generator",
    description: "Calculate cryptographic hashes",
    icon: "#️⃣",
    category: "encoding",
  },
  {
    id: "url-analyzer",
    name: "URL Analyzer",
    description: "Analyze URLs for security",
    icon: "🔗",
    category: "security",
  },
  {
    id: "password-generator",
    name: "Password Generator",
    description: "Generate secure passwords",
    icon: "🔑",
    category: "security",
  },
  {
    id: "encoding",
    name: "Encoding Tool",
    description: "Encode/decode data",
    icon: "🔀",
    category: "encoding",
  },
]

export function ToolsDashboard() {
  const [selectedCategory, setSelectedCategory] = createSignal<"all" | Tool["category"]>("all")
  const [hoveredTool, setHoveredTool] = createSignal<string | null>(null)

  const categories = ["all", "security", "networking", "analysis", "encoding"] as const
  const categoryIcons: Record<string, string> = {
    all: "🛠️",
    security: "🔒",
    networking: "📡",
    analysis: "📊",
    encoding: "🔐",
  }

  const filteredTools = () => {
    const cat = selectedCategory()
    return cat === "all" ? CYBERSECURITY_TOOLS : CYBERSECURITY_TOOLS.filter((t) => t.category === cat)
  }

  return (
    <div class="flex flex-col h-full bg-surface-base rounded-lg border border-surface-weak overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-surface-weak bg-surface-weak">
        <h2 class="text-14-semibold text-text-strong">Cybersecurity Tools</h2>
        <span class="text-12-regular text-text-subtle bg-surface-base px-2 py-1 rounded">{filteredTools().length}</span>
      </div>

      {/* Category Filter */}
      <div class="flex gap-2 px-4 py-3 border-b border-surface-weak overflow-x-auto">
        <For each={categories}>
          {(cat) => (
            <button
              onclick={() => setSelectedCategory(cat)}
              class={`flex items-center gap-1 px-3 py-1.5 rounded text-12-regular whitespace-nowrap transition-colors ${
                selectedCategory() === cat
                  ? "bg-icon-warning-base text-text-contrast"
                  : "bg-surface-weak text-text-secondary hover:bg-surface-muted"
              }`}
            >
              <span>{categoryIcons[cat]}</span>
              <span class="capitalize">{cat === "all" ? "All Tools" : cat}</span>
            </button>
          )}
        </For>
      </div>

      {/* Tools Grid */}
      <div class="flex-1 overflow-y-auto p-4">
        <div class="grid grid-cols-2 gap-3">
          <For each={filteredTools()}>
            {(tool) => (
              <Tooltip value={tool.description}>
                <button
                  onmouseenter={() => setHoveredTool(tool.id)}
                  onmouseleave={() => setHoveredTool(null)}
                  class={`flex flex-col items-center gap-2 p-3 rounded border-2 transition-all ${
                    hoveredTool() === tool.id
                      ? "border-icon-warning-base bg-surface-muted"
                      : "border-surface-weak bg-surface-base hover:border-surface-muted"
                  }`}
                >
                  <div class="text-24">{tool.icon}</div>
                  <div class="text-11-regular text-text-secondary text-center">{tool.name}</div>
                  <Show when={tool.shortcut}>
                    <div class="text-10-regular text-text-subtle bg-surface-weak px-1.5 py-0.5 rounded">
                      {tool.shortcut}
                    </div>
                  </Show>
                </button>
              </Tooltip>
            )}
          </For>
        </div>
      </div>

      {/* Footer */}
      <div class="flex items-center gap-2 px-4 py-3 border-t border-surface-weak bg-surface-weak">
        <div class="flex-1 text-12-regular text-text-subtle">{filteredTools().length} tools available</div>
        <Button size="small" variant="secondary">
          View All
        </Button>
      </div>
    </div>
  )
}
