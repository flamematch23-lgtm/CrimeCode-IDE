import { createSignal, Show } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"

type ThemeMode = "light" | "dark" | "auto"

interface ThemeOption {
  id: ThemeMode
  label: string
  icon: string
  description: string
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: "light", label: "Light", icon: "L", description: "Use light theme" },
  { id: "dark", label: "Dark", icon: "D", description: "Use dark theme" },
  { id: "auto", label: "Auto", icon: "A", description: "Follow system preference" },
]

export function ThemeSwitcher() {
  const stored = localStorage.getItem("theme-preference") as ThemeMode | null
  const initial: ThemeMode = stored === "light" || stored === "dark" || stored === "auto" ? stored : "auto"
  const [isOpen, setIsOpen] = createSignal(false)
  const [currentTheme, setCurrentTheme] = createSignal<ThemeMode>(initial)

  const getCurrentThemeOption = () => {
    return THEME_OPTIONS.find((opt) => opt.id === currentTheme()) || THEME_OPTIONS[2]
  }

  const handleThemeChange = (themeId: ThemeMode) => {
    // Store preference
    localStorage.setItem("theme-preference", themeId)
    setCurrentTheme(themeId)

    // Apply theme
    if (themeId === "auto") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
      document.documentElement.classList.toggle("dark", prefersDark)
    } else {
      document.documentElement.classList.toggle("dark", themeId === "dark")
    }

    setIsOpen(false)
  }

  return (
    <div class="relative">
      {/* Theme Toggle Button */}
      <Tooltip value="Change theme">
        <button
          onclick={() => setIsOpen(!isOpen())}
          class="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-surface-weak transition-colors cursor-pointer"
          aria-label="Toggle theme menu"
        >
          <span class="text-18">{getCurrentThemeOption().icon}</span>
        </button>
      </Tooltip>

      {/* Theme Menu Dropdown */}
      <Show when={isOpen()}>
        <div class="absolute right-0 mt-2 w-48 bg-surface-base border border-surface-weak rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Menu Header */}
          <div class="px-4 py-2 border-b border-surface-weak bg-surface-weak/50">
            <p class="text-12-semibold text-text-strong">Appearance</p>
            <p class="text-11-regular text-text-subtle">Select your preferred theme</p>
          </div>

          {/* Theme Options */}
          <div class="py-1">
            {THEME_OPTIONS.map((option) => (
              <button
                onclick={() => handleThemeChange(option.id)}
                class={`w-full flex items-center gap-3 px-4 py-2 transition-colors text-12-regular ${
                  currentTheme() === option.id
                    ? "bg-icon-warning-base/20 text-text-strong border-l-2 border-icon-warning-base"
                    : "text-text-secondary hover:bg-surface-weak hover:text-text-strong"
                }`}
              >
                <span class="text-16">{option.icon}</span>
                <div class="flex-1 text-left">
                  <p class="font-medium">{option.label}</p>
                  <p class="text-10-regular text-text-subtle">{option.description}</p>
                </div>
                <Show when={currentTheme() === option.id}>
                  <span class="text-14">✓</span>
                </Show>
              </button>
            ))}
          </div>

          {/* Preview Section */}
          <div class="px-4 py-3 border-t border-surface-weak bg-surface-weak/30">
            <p class="text-11-regular text-text-subtle mb-2">Preview:</p>
            <div class="grid grid-cols-3 gap-2">
              <div class="h-6 rounded bg-surface-base border border-surface-weak" />
              <div class="h-6 rounded bg-surface-weak" />
              <div class="h-6 rounded bg-icon-warning-base/20" />
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
