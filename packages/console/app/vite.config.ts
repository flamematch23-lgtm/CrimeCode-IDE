import { defineConfig, PluginOption } from "vite"
import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"

const preset = process.env.NITRO_PRESET || "cloudflare_module"

export default defineConfig({
  plugins: [
    solidStart({
      middleware: "./src/middleware.ts",
    }) as PluginOption,
    nitro({
      compatibilityDate: "2024-09-19",
      preset: preset as "cloudflare_module" | "azure_swa",
      ...(preset === "cloudflare_module"
        ? {
            cloudflare: { nodeCompat: true },
          }
        : {}),
    }),
  ],
  server: {
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
    minify: false,
  },
})
