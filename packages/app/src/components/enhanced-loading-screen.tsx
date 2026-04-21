import { createSignal, createEffect, onCleanup } from "solid-js"

interface LoadingStep {
  label: string
  duration: number
}

export function EnhancedLoadingScreen(props: { onComplete?: () => void }) {
  const [progress, setProgress] = createSignal(0)
  const [currentStep, setCurrentStep] = createSignal(0)
  const [isComplete, setIsComplete] = createSignal(false)

  const steps: LoadingStep[] = [
    { label: "Initializing...", duration: 800 },
    { label: "Loading database...", duration: 2000 },
    { label: "Registering tools...", duration: 1200 },
    { label: "Connecting services...", duration: 1500 },
  ]

  createEffect(() => {
    let currentProgress = 0
    const increment = 100 / (steps.reduce((sum, s) => sum + s.duration, 0) / 50)

    const progressInterval = setInterval(() => {
      currentProgress += increment
      if (currentProgress >= 100) {
        currentProgress = 100
        setProgress(100)
        setIsComplete(true)
        clearInterval(progressInterval)
      } else {
        setProgress(currentProgress)
      }
    }, 50)

    onCleanup(() => clearInterval(progressInterval))
  })

  createEffect(() => {
    let stepIndex = 0
    setCurrentStep(0)

    const stepTimer = setInterval(() => {
      if (stepIndex < steps.length - 1) {
        stepIndex++
        setCurrentStep(stepIndex)
      } else {
        clearInterval(stepTimer)
      }
    }, 2000)

    onCleanup(() => clearInterval(stepTimer))
  })

  return (
    <div class="w-screen h-screen bg-gradient-to-br from-surface-base via-background-base to-surface-base flex items-center justify-center overflow-hidden">
      {/* Animated Background Elements */}
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-icon-warning-base/10 rounded-full blur-3xl animate-pulse" />
        <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-icon-warning-base/5 rounded-full blur-3xl animate-pulse animation-delay-2000" />
      </div>

      {/* Content */}
      <div class="relative z-10 flex flex-col items-center gap-8 max-w-md">
        {/* Logo Area */}
        <div class="flex flex-col items-center gap-4">
          <div class="relative">
            <div class="w-20 h-20 bg-gradient-to-br from-icon-warning-base to-icon-warning-base/80 rounded-lg flex items-center justify-center shadow-lg">
              <span class="text-32 font-bold text-white">C</span>
            </div>
            <div class="absolute -top-2 -right-2 w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-12 animate-bounce">
              ✓
            </div>
          </div>
          <div class="text-center">
            <h1 class="text-24-bold text-text-strong">OpenCode</h1>
            <p class="text-12-regular text-text-secondary mt-1">Initializing Security Suite</p>
          </div>
        </div>

        {/* Progress Section */}
        <div class="w-full flex flex-col gap-4">
          {/* Progress Bar */}
          <div class="flex flex-col gap-2">
            <div class="h-2 w-full bg-surface-weak rounded-full overflow-hidden">
              <div
                class="h-full bg-gradient-to-r from-icon-warning-base to-icon-warning-base/60 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress()}%` }}
              />
            </div>
            <div class="flex justify-between items-center">
              <span class="text-11-regular text-text-subtle">{steps[currentStep()].label}</span>
              <span class="text-11-semibold text-text-secondary">{Math.round(progress())}%</span>
            </div>
          </div>

          {/* Steps Indicator */}
          <div class="flex gap-1">
            {steps.map((_, i) => (
              <div
                class={`flex-1 h-1 rounded-full transition-all duration-300 ${
                  i <= currentStep() ? "bg-icon-warning-base" : "bg-surface-weak"
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 0.3;
          }
          50% {
            opacity: 0.1;
          }
        }
        @keyframes bounce {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-8px);
          }
        }
        .animate-pulse {
          animation: pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        .animate-bounce {
          animation: bounce 1s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2000ms;
        }
      `}</style>
    </div>
  )
}
