import { existsSync, mkdirSync, renameSync, statSync, copyFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"

/**
 * Automated Windows build for CrimeCode Desktop.
 *
 * Steps:
 *  1. Move sidecar/ out of project tree so electron-builder can't pack it into app.asar
 *  2. Run electron-vite build (compiles main/renderer/preload)
 *  3. Run electron-builder --win (creates dist/win-unpacked without sidecar in asar)
 *  4. Copy sidecar binary into dist/win-unpacked/resources/
 *  5. Rebuild NSIS installer from the prepackaged directory
 *  6. Move sidecar/ back into the project tree
 */

const root = resolve(import.meta.dir, "..")
const sidecar = join(root, "sidecar")
const binary = join(sidecar, "opencode-cli.exe")
const stash = join(root, "..", "..", ".sidecar-stash")
const stashed = join(stash, "opencode-cli.exe")
const unpacked = join(root, "dist", "win-unpacked", "resources")
const target = join(unpacked, "opencode-cli.exe")
const proxySource = join(root, "..", "proxy", "dist")
const proxyTarget = join(unpacked, "proxy")
// Burp proxy compiled standalone — built via `bun build --compile` da
// packages/opencode/script/agent-tools/security/http-proxy.ts. Spawnabile
// senza bun runtime al lato utente.
const burpProxySource = join(root, "..", "opencode", "script", "agent-tools", "security", "http-proxy.ts")
const burpProxyBinary = join(sidecar, "burp-proxy-cli.exe")
const burpProxyTarget = join(unpacked, "burp-proxy-cli.exe")

function size(path: string) {
  return (statSync(path).size / 1024 / 1024).toFixed(1)
}

async function main() {
  // Preflight
  if (!existsSync(binary)) {
    console.error(`[build-win] Sidecar binary not found: ${binary}`)
    console.error(`[build-win] Build the CLI first: cd packages/opencode && bun run build`)
    process.exit(1)
  }
  console.log(`[build-win] Sidecar binary: ${binary} (${size(binary)} MB)`)

  // Step 0: compile burp-proxy-cli (Burp Workspace MITM proxy) into a
  // standalone exe via `bun build --compile`. Senza questo step la UI mostra
  // "Script http-proxy.ts non trovato" cliccando "Avvia proxy ora".
  if (existsSync(burpProxySource)) {
    console.log(`[build-win] Step 0: Compiling burp-proxy-cli.exe da ${burpProxySource}`)
    try {
      await $`bun build --compile --target=bun-windows-x64 ${burpProxySource} --outfile ${burpProxyBinary}`.cwd(root)
      if (existsSync(burpProxyBinary)) {
        console.log(`[build-win] burp-proxy-cli.exe built (${size(burpProxyBinary)} MB)`)
      } else {
        console.warn(`[build-win] WARN: bun build completed but binary missing at ${burpProxyBinary}`)
      }
    } catch (err) {
      console.error(`[build-win] WARN: failed to build burp-proxy-cli.exe — proseguo senza`, err)
    }
  } else {
    console.warn(`[build-win] WARN: burp-proxy source not found at ${burpProxySource}, Burp Workspace verrà shippato senza il binario.`)
  }

  // Step 1: stash sidecar out of project tree
  console.log(`[build-win] Step 1: Moving sidecar to ${stash}`)
  mkdirSync(stash, { recursive: true })
  renameSync(binary, stashed)
  console.log(`[build-win] Sidecar stashed`)

  try {
    // Step 2: electron-vite build
    console.log(`[build-win] Step 2: Running electron-vite build`)
    await $`bun run build`.cwd(root)
    console.log(`[build-win] electron-vite build complete`)

    // Step 3: electron-builder --win
    console.log(`[build-win] Step 3: Running electron-builder --win`)
    await $`bunx electron-builder --win --config electron-builder.config.ts`.cwd(root)
    console.log(`[build-win] electron-builder complete`)

    // Step 4: copy sidecar into unpacked resources
    console.log(`[build-win] Step 4: Copying sidecar to ${target}`)
    mkdirSync(unpacked, { recursive: true })
    copyFileSync(stashed, target)
    console.log(`[build-win] Sidecar copied (${size(target)} MB)`)

    // Step 4a: copy burp-proxy-cli (if built) so ipc.ts → spawn lo trova
    // anche se electron-builder filter non l'ha incluso (es: filter di
    // sicurezza che salta i .exe non firmati durante la fase prepackaged).
    if (existsSync(burpProxyBinary)) {
      console.log(`[build-win] Step 4a: Copying burp-proxy-cli to ${burpProxyTarget}`)
      copyFileSync(burpProxyBinary, burpProxyTarget)
      console.log(`[build-win] burp-proxy-cli copied (${size(burpProxyTarget)} MB)`)
    } else {
      console.log(`[build-win] Step 4a: skipping burp-proxy-cli copy — binary missing`)
    }

    // Step 4b: copy proxy into unpacked resources/proxy
    console.log(`[build-win] Step 4b: Copying proxy to ${proxyTarget}`)
    const proxyFile = join(proxySource, "index.cjs")
    if (existsSync(proxyFile)) {
      mkdirSync(proxyTarget, { recursive: true })
      copyFileSync(proxyFile, join(proxyTarget, "index.cjs"))
      console.log(`[build-win] Proxy copied`)
    } else {
      console.log(`[build-win] Warning: proxy not found at ${proxyFile}, skipping`)
    }

    // Step 5: rebuild NSIS from prepackaged
    console.log(`[build-win] Step 5: Rebuilding NSIS installer from prepackaged`)
    await $`bunx electron-builder --win --prepackaged dist/win-unpacked --config electron-builder.config.ts`.cwd(root)
    console.log(`[build-win] NSIS installer rebuilt`)

    // Summary
    const dist = join(root, "dist")
    const asar = join(unpacked, "app.asar")
    console.log(`\n[build-win] === Build Complete ===`)
    if (existsSync(asar)) console.log(`[build-win] app.asar: ${size(asar)} MB`)
    if (existsSync(target)) console.log(`[build-win] sidecar:  ${size(target)} MB`)
    console.log(`[build-win] Check dist/ for the installer`)
  } finally {
    // Step 6: restore sidecar
    console.log(`[build-win] Step 6: Restoring sidecar to ${binary}`)
    mkdirSync(sidecar, { recursive: true })
    if (existsSync(stashed)) {
      renameSync(stashed, binary)
      console.log(`[build-win] Sidecar restored`)
    }
  }
}

main().catch((err) => {
  console.error(`[build-win] Build failed:`, err)
  // Emergency restore
  if (existsSync(stashed) && !existsSync(binary)) {
    mkdirSync(sidecar, { recursive: true })
    renameSync(stashed, binary)
    console.log(`[build-win] Sidecar restored after failure`)
  }
  process.exit(1)
})
