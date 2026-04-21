import "solid-js"

interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST: string
  readonly VITE_OPENCODE_SERVER_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface ElectronAPI {
  browserPreviewNavigate?: (url: string) => void
  onBrowserPreviewNavigate?: (handler: (url: string) => void) => void
}

interface Window {
  api?: ElectronAPI
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
