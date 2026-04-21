import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Component, Show, createSignal, type ParentProps } from "solid-js"

export type ErrorFallbackProps = {
  error: unknown
  reset: () => void
}

export type ErrorFallback = Component<ErrorFallbackProps>

interface ComponentErrorBoundaryProps extends ParentProps {
  fallback: ErrorFallback
  onError?: (error: unknown) => void
}

export const ComponentErrorBoundary: Component<ComponentErrorBoundaryProps> = (props) => {
  const [error, setError] = createSignal<unknown>(null)

  return (
    <Show
      when={!error()}
      fallback={
        <props.fallback
          error={error()!}
          reset={() => {
            setError(null)
          }}
        />
      }
    >
      {(() => {
        try {
          return props.children
        } catch (err) {
          const caughtError = err instanceof Error ? err : new Error(String(err))
          setError(caughtError)
          props.onError?.(caughtError)
          return null
        }
      })()}
    </Show>
  )
}

export const DefaultFallback: ErrorFallback = (props) => {
  const message = () => {
    const err = props.error
    if (err instanceof Error) return err.message
    if (typeof err === "string") return err
    return "An unexpected error occurred"
  }

  return (
    <div class="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <Icon name="warning" class="text-text-danger-base size-12" />
      <div class="flex flex-col gap-2">
        <h3 class="text-lg font-medium text-text-strong">Something went wrong</h3>
        <p class="text-sm text-text-weak max-w-md">{message()}</p>
      </div>
      <Button variant="ghost" onClick={props.reset}>
        Try Again
      </Button>
    </div>
  )
}

export const InlineFallback: ErrorFallback = (props) => {
  const message = () => {
    const err = props.error
    if (err instanceof Error) return err.message
    if (typeof err === "string") return err
    return "Error"
  }

  return (
    <div class="flex items-center gap-2 text-text-danger-base">
      <Icon name="warning" class="size-4" />
      <span class="text-sm">{message()}</span>
      <button type="button" class="ml-2 text-xs text-text-interactive-base hover:underline" onClick={props.reset}>
        Retry
      </button>
    </div>
  )
}
