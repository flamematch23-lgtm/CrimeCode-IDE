import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const checkoutBaseUrl = process.env.OPENCODE_CHECKOUT_BASE_URL ?? "https://opencode.ai/billing/pro"
const adminPassphraseSha256 = (process.env.OPENCODE_ADMIN_PASSPHRASE_SHA256 ?? "").toLowerCase()

const sharedDefine = {
  "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
  "import.meta.env.OPENCODE_CHECKOUT_BASE_URL": JSON.stringify(checkoutBaseUrl),
  "import.meta.env.OPENCODE_ADMIN_PASSPHRASE_SHA256": JSON.stringify(adminPassphraseSha256),
}

export default defineConfig({
  main: {
    define: sharedDefine,
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
