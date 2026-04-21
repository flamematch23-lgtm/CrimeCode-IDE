import { createSignal, For } from "solid-js"

interface ActivityItem {
  id: string
  tool: string
  icon: string
  action: string
  timestamp: Date
  status: "success" | "pending" | "error"
}

export function ActivityFeed() {
  const [activities, setActivities] = createSignal<ActivityItem[]>([])
  const [maxItems] = createSignal(8)

  const formatTime = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return "now"
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return date.toLocaleDateString()
  }

  const getStatusColor = (status: ActivityItem["status"]) => {
    switch (status) {
      case "success":
        return "text-green-600 dark:text-green-400"
      case "pending":
        return "text-yellow-600 dark:text-yellow-400"
      case "error":
        return "text-red-600 dark:text-red-400"
    }
  }

  const getStatusDot = (status: ActivityItem["status"]) => {
    switch (status) {
      case "success":
        return "bg-green-600 dark:bg-green-400"
      case "pending":
        return "bg-yellow-600 dark:bg-yellow-400 animate-pulse"
      case "error":
        return "bg-red-600 dark:bg-red-400"
    }
  }

  return (
    <div class="flex flex-col h-full bg-surface-base rounded-lg border border-surface-weak overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-surface-weak bg-surface-weak">
        <h2 class="text-14-semibold text-text-strong">Recent Activity</h2>
        <span class="text-12-regular text-text-subtle bg-surface-base px-2 py-1 rounded">{activities().length}</span>
      </div>

      {/* Activity List */}
      <div class="flex-1 overflow-y-auto">
        {activities().length === 0 ? (
          <div class="flex items-center justify-center h-full px-4 py-8">
            <p class="text-12-regular text-text-subtle text-center">
              No recent activity. Execute a tool to get started.
            </p>
          </div>
        ) : (
          <div class="divide-y divide-surface-weak">
            <For each={activities()}>
              {(activity) => (
                <div class="flex items-start gap-3 px-4 py-3 hover:bg-surface-muted transition-colors">
                  <div
                    class={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-14 ${getStatusDot(activity.status)}`}
                  />

                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <p class="text-12-semibold text-text-strong truncate">{activity.tool}</p>
                      <span class="text-10-regular text-text-subtle whitespace-nowrap">
                        {formatTime(activity.timestamp)}
                      </span>
                    </div>
                    <p class="text-11-regular text-text-secondary truncate">{activity.action}</p>
                  </div>

                  <div class={`flex-shrink-0 text-12-semibold ${getStatusColor(activity.status)}`}>
                    {activity.status === "success" && "✓"}
                    {activity.status === "pending" && "⋯"}
                    {activity.status === "error" && "✕"}
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </div>

      {/* Footer */}
      <div class="flex items-center justify-center px-4 py-3 border-t border-surface-weak bg-surface-weak">
        <button class="text-12-regular text-text-secondary hover:text-text-strong transition-colors">
          Clear history
        </button>
      </div>
    </div>
  )
}
