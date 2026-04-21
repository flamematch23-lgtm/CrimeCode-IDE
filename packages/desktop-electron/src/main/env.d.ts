interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_CHECKOUT_BASE_URL?: string
  readonly OPENCODE_ADMIN_PASSPHRASE_SHA256?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
