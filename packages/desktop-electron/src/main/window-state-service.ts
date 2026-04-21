type WindowState = {
  [key: string]: unknown
}

export class WindowStateService {
  private state: Map<string, WindowState> = new Map()
  private persistence: Map<string, WindowState> = new Map()

  get(windowId: string, key: string): unknown {
    const windowState = this.state.get(windowId)
    return windowState?.[key] ?? null
  }

  set(windowId: string, key: string, value: unknown): void {
    let windowState = this.state.get(windowId)
    if (!windowState) {
      windowState = {}
      this.state.set(windowId, windowState)
    }
    windowState[key] = value
  }

  delete(windowId: string, key: string): void {
    const windowState = this.state.get(windowId)
    if (windowState) {
      delete windowState[key]
    }
  }

  clear(windowId: string): void {
    this.state.delete(windowId)
  }

  getAll(windowId: string): WindowState {
    return this.state.get(windowId) ?? {}
  }

  setPersistent(key: string, value: unknown): void {
    this.persistence.set(key, value as WindowState)
  }

  getPersistent(key: string): unknown {
    return this.persistence.get(key) ?? null
  }

  cleanup(): void {
    this.state.clear()
  }
}

export const windowStateService = new WindowStateService()
