import "solid-js"

interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST: string
  readonly VITE_OPENCODE_SERVER_PORT: string
  /**
   * Production API URL override. When set at build time, the web app connects
   * to this server instead of the current origin / localhost. Used by the
   * Cloudflare Pages deploy to point at the Fly.io backend.
   */
  readonly VITE_API_URL?: string
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
