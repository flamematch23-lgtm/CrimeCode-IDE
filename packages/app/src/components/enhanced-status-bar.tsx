import { createSignal, For, Show, createEffect } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"

interface StatusIndicator {
  id: string
  label: string
  status: "online" | "idle" | "offline"
  icon: string
  details?: string
}

interface StatusMetric {
  label: string
  value: string | number
  icon: string
  unit?: string
}

export function EnhancedStatusBar() {
  const [indicators, setIndicators] = createSignal<StatusIndicator[]>([
    { id: "server", label: "Server", status: "online", icon: "🌐", details: "Connected" },
    { id: "tools", label: "Tools", status: "online", icon: "🔧", details: "23 available" },
    { id: "database", label: "Database", status: "online", icon: "💾", details: "Synced" },
  ])

  const [metrics, setMetrics] = createSignal<StatusMetric[]>([
    { label: "Tools", value: 23, icon: "🔧" },
    { label: "Invites", value: 0, icon: "📨" },
    { label: "Workflows", value: 4, icon: "📋" },
  ])

  const getStatusColor = (status: StatusIndicator["status"]) => {
    switch (status) {
      case "online":
        return "text-green-600 dark:text-green-400"
      case "idle":
        return "text-yellow-600 dark:text-yellow-400"
      case "offline":
        return "text-red-600 dark:text-red-400"
    }
  }

  const getStatusBg = (status: StatusIndicator["status"]) => {
    switch (status) {
      case "online":
        return "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300"
      case "idle":
        return "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300"
      case "offline":
        return "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
    }
  }

  return (
    <div class="flex flex-col bg-surface-base border-t border-surface-weak">
      {/* Status Indicators Row */}
      <div class="flex items-center justify-between px-4 py-2 border-b border-surface-weak bg-surface-weak/50">
        <div class="flex items-center gap-4">
          <span class="text-11-semibold text-text-subtle uppercase tracking-wide">Status</span>
          <div class="flex items-center gap-3">
            <For each={indicators()}>
              {(indicator) => (
                <Tooltip value={indicator.details || indicator.label}>
                  <div
                    class={`flex items-center gap-1.5 px-2.5 py-1 rounded text-11-regular font-medium ${getStatusBg(indicator.status)}`}
                  >
                    <div class="flex items-center justify-center w-4 h-4">
                      {indicator.status === "online" && (
                        <div class="w-2 h-2 bg-green-600 dark:bg-green-400 rounded-full animate-pulse" />
                      )}
                      {indicator.status === "idle" && (
                        <div class="w-2 h-2 bg-yellow-600 dark:bg-yellow-400 rounded-full" />
                      )}
                      {indicator.status === "offline" && (
                        <div class="w-2 h-2 bg-red-600 dark:bg-red-400 rounded-full" />
                      )}
                    </div>
                    <span>{indicator.label}</span>
                  </div>
                </Tooltip>
              )}
            </For>
          </div>
        </div>

        {/* Right Side Info */}
        <div class="flex items-center gap-2 text-11-regular text-text-subtle">
          <span>•</span>
          <span>Last updated: now</span>
        </div>
      </div>

      {/* Metrics Row */}
      <div class="flex items-center justify-between px-4 py-2 gap-4">
        <div class="flex items-center gap-4">
          <For each={metrics()}>
            {(metric) => (
              <Tooltip value={metric.label}>
                <div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-weak transition-colors cursor-pointer">
                  <span class="text-14">{metric.icon}</span>
                  <span class="text-11-regular text-text-secondary">
                    <span class="font-semibold text-text-strong">{metric.value}</span>
                    {metric.unit && <span> {metric.unit}</span>}
                  </span>
                </div>
              </Tooltip>
            )}
          </For>
        </div>

        {/* Actions */}
        <div class="flex items-center gap-2">
          <button class="text-11-regular text-text-secondary hover:text-text-strong px-2 py-1 rounded hover:bg-surface-weak transition-colors">
            Settings
          </button>
          <span class="text-surface-weak">•</span>
          <button class="text-11-regular text-text-secondary hover:text-text-strong px-2 py-1 rounded hover:bg-surface-weak transition-colors">
            Help
          </button>
        </div>
      </div>
    </div>
  )
}
