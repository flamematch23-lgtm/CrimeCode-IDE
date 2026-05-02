import type { Configuration } from "electron-builder"
import fs from "fs"
import path from "path"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Optional self-signed Windows code-signing.
// Set SIGN_CERT=path/to/cert.pfx and SIGN_PASS=... or place a cert at sidecar/cert.pfx.
const signCert = process.env.SIGN_CERT || path.join(__dirname, "sidecar", "cert.pfx")
const signPass = process.env.SIGN_PASS || ""
const signEnabled = fs.existsSync(signCert)

const winSign = signEnabled
  ? ({
      signtoolOptions: {
        certificateFile: signCert,
        certificatePassword: signPass,
        signingHashAlgorithms: ["sha256"],
        publisherName: process.env.SIGN_PUBLISHER || "OpenCode Dev (Self-signed)",
      },
      files: ["!**/opencode-cli*"],
    } satisfies Partial<NonNullable<Configuration["win"]>>)
  : {}

const getBase = (): Configuration => ({
  artifactName: "opencode-electron-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  asarUnpack: ["resources/opencode-cli*"],
  extraResources: [
    // The runtime tray reads `process.resourcesPath/icons/icon.ico` (see
    // tray.ts). Without this entry the icons end up packed inside app.asar
    // which is not where the tray code looks — Tray() would throw and the
    // splash overlay would never get destroyed.
    {
      from: "resources/icons/",
      to: "icons/",
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    ...(process.env.SKIP_SIDECAR_PACK === "1"
      ? []
      : [
          {
            from: "sidecar/",
            to: ".",
            filter: ["opencode-cli*"],
          },
        ]),
    {
      from: "../proxy/dist/",
      to: "proxy/",
      filter: ["index.cjs"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
    ...winSign,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      // The dev channel ships GitHub auto-updates by default (the legacy
      // "https://opencode-dev.local/updates" placeholder broke auto-update
      // entirely — clients running the dev build would silently fail to
      // discover new releases). Override with PUBLISH_URL env if you want
      // to host your own private feed.
      const useGeneric = !!process.env.PUBLISH_URL
      return {
        ...base,
        appId: "ai.opencode.desktop.dev",
        productName: "OpenCode Dev",
        publish: useGeneric
          ? {
              provider: "generic",
              url: process.env.PUBLISH_URL!,
              channel: "latest",
            }
          : {
              provider: "github",
              owner: "samupae2300-star",
              repo: "CrimeCode-IDE",
              channel: "latest",
              releaseType: "release",
            },
        rpm: { packageName: "opencode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.opencode.desktop.beta",
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "flamematch23-lgtm", repo: "CrimeCode-IDE", channel: "beta" },
        rpm: { packageName: "opencode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.opencode.desktop",
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "flamematch23-lgtm", repo: "CrimeCode-IDE", channel: "latest" },
        rpm: { packageName: "opencode" },
      }
    }
  }
}

export default getConfig()
