import sharp from "sharp"
import pngToIco from "png-to-ico"
import { mkdirSync, writeFileSync, copyFileSync } from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dir, "..")
const SRC = path.join(ROOT, "logo.png")
const TAURI_DEV = path.join(ROOT, "packages/desktop/src-tauri/icons/dev")
const TAURI_ASSETS = path.join(ROOT, "packages/desktop/src-tauri/assets")

async function resize(size: number, out: string) {
  await sharp(SRC)
    .resize(size, size, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toFile(out)
  console.log(`  -> ${path.basename(out)} (${size}x${size})`)
}

async function toBmp(src: string, out: string, w: number, h: number) {
  // Sharp doesn't support BMP, so we write it manually from raw RGB
  const { data, info } = await sharp(src)
    .resize(w, h, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const rowBytes = w * 3
  const padding = (4 - (rowBytes % 4)) % 4
  const stride = rowBytes + padding
  const pixelSize = stride * h
  const fileSize = 54 + pixelSize

  const buf = Buffer.alloc(fileSize)
  // BMP Header
  buf.write("BM", 0)
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(0, 6)
  buf.writeUInt32LE(54, 10)
  // DIB Header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18)
  buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26) // planes
  buf.writeUInt16LE(24, 28) // bits per pixel
  buf.writeUInt32LE(0, 30) // no compression
  buf.writeUInt32LE(pixelSize, 34)
  buf.writeUInt32LE(2835, 38) // h res
  buf.writeUInt32LE(2835, 42) // v res

  // Pixel data (BMP is bottom-up, BGR)
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 3
    const dstRow = 54 + y * stride
    for (let x = 0; x < w; x++) {
      const si = srcRow + x * 3
      const di = dstRow + x * 3
      buf[di] = data[si + 2]! // B
      buf[di + 1] = data[si + 1]! // G
      buf[di + 2] = data[si]! // R
    }
  }

  writeFileSync(out, buf)
  console.log(`  -> ${path.basename(out)} (${w}x${h} BMP)`)
}

async function main() {
  console.log("Source:", SRC)
  console.log()

  // Root icons
  console.log("=== Root icons ===")
  const rootIcon = path.join(ROOT, "icon.png")
  copyFileSync(SRC, rootIcon)
  console.log("  -> icon.png (full size copy)")

  // Generate 256x256 PNG for ICO
  const ico256 = path.join(ROOT, "tmp-256.png")
  await resize(256, ico256)
  const icoBuffer = await pngToIco(ico256)
  writeFileSync(path.join(ROOT, "icon.ico"), icoBuffer)
  console.log("  -> icon.ico")

  // Tauri dev icons
  console.log()
  console.log("=== Tauri dev icons ===")

  // Main icon.png (full size)
  copyFileSync(SRC, path.join(TAURI_DEV, "icon.png"))
  console.log("  -> icon.png (full size copy)")

  // Standard sizes
  const sizes = [
    { size: 32, name: "32x32.png" },
    { size: 64, name: "64x64.png" },
    { size: 128, name: "128x128.png" },
    { size: 256, name: "128x128@2x.png" },
  ]
  for (const s of sizes) {
    await resize(s.size, path.join(TAURI_DEV, s.name))
  }

  // Square logos for Windows Store
  const squares = [30, 44, 71, 89, 107, 142, 150, 284, 310]
  for (const s of squares) {
    await resize(s, path.join(TAURI_DEV, `Square${s}x${s}Logo.png`))
  }

  // StoreLogo
  await resize(50, path.join(TAURI_DEV, "StoreLogo.png"))

  // ICO for dev
  const devIco256 = path.join(TAURI_DEV, "tmp-256.png")
  await resize(256, devIco256)
  // Multi-size ICO: 16, 32, 48, 64, 128, 256
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoPngs: string[] = []
  for (const s of icoSizes) {
    const p = path.join(TAURI_DEV, `tmp-ico-${s}.png`)
    await resize(s, p)
    icoPngs.push(p)
  }
  const devIcoBuffer = await pngToIco(icoPngs)
  writeFileSync(path.join(TAURI_DEV, "icon.ico"), devIcoBuffer)
  console.log("  -> icon.ico (multi-size)")

  // Clean temp files
  const { unlinkSync } = await import("fs")
  unlinkSync(ico256)
  unlinkSync(devIco256)
  for (const p of icoPngs) {
    try {
      unlinkSync(p)
    } catch {}
  }

  // NSIS BMP images
  console.log()
  console.log("=== NSIS BMP images ===")
  // Header: 150x57 BMP
  await toBmp(SRC, path.join(TAURI_ASSETS, "nsis-header.bmp"), 150, 57)
  // Sidebar: 164x314 BMP
  await toBmp(SRC, path.join(TAURI_ASSETS, "nsis-sidebar.bmp"), 164, 314)

  // iOS icons
  console.log()
  console.log("=== iOS icons ===")
  const iosDir = path.join(TAURI_DEV, "ios")
  mkdirSync(iosDir, { recursive: true })
  const iosIcons = [
    { name: "AppIcon-20x20@1x.png", size: 20 },
    { name: "AppIcon-20x20@2x.png", size: 40 },
    { name: "AppIcon-20x20@2x-1.png", size: 40 },
    { name: "AppIcon-20x20@3x.png", size: 60 },
    { name: "AppIcon-29x29@1x.png", size: 29 },
    { name: "AppIcon-29x29@2x.png", size: 58 },
    { name: "AppIcon-29x29@2x-1.png", size: 58 },
    { name: "AppIcon-29x29@3x.png", size: 87 },
    { name: "AppIcon-40x40@1x.png", size: 40 },
    { name: "AppIcon-40x40@2x.png", size: 80 },
    { name: "AppIcon-40x40@2x-1.png", size: 80 },
    { name: "AppIcon-40x40@3x.png", size: 120 },
    { name: "AppIcon-60x60@2x.png", size: 120 },
    { name: "AppIcon-60x60@3x.png", size: 180 },
    { name: "AppIcon-76x76@1x.png", size: 76 },
    { name: "AppIcon-76x76@2x.png", size: 152 },
    { name: "AppIcon-83.5x83.5@2x.png", size: 167 },
    { name: "AppIcon-512@2x.png", size: 1024 },
  ]
  for (const i of iosIcons) {
    await resize(i.size, path.join(iosDir, i.name))
  }

  // Android icons
  console.log()
  console.log("=== Android icons ===")
  const androidDir = path.join(TAURI_DEV, "android/mipmap-xxxhdpi")
  mkdirSync(androidDir, { recursive: true })
  await resize(192, path.join(androidDir, "ic_launcher.png"))
  await resize(192, path.join(androidDir, "ic_launcher_round.png"))
  await resize(432, path.join(androidDir, "ic_launcher_foreground.png"))

  // ICNS for macOS (just copy large PNG, tauri builds icns from it)
  // We'll generate a proper icns by embedding a 512x512 and 1024x1024
  console.log()
  console.log("=== macOS icns ===")
  // For now, we create a 1024x1024 PNG and rename - Tauri can use PNG as fallback
  // But for a real .icns we need iconutil or a node package
  const icns1024 = path.join(TAURI_DEV, "icon-1024.png")
  await resize(1024, icns1024)
  // Use png2icons if available, otherwise just keep the png
  try {
    const { execSync } = await import("child_process")
    // Try to create icns using sips on macOS (won't work on Windows)
    // On Windows we'll just copy a large PNG as icon.icns placeholder
    console.log("  -> Skipping .icns generation on Windows (use macOS for proper icns)")
    copyFileSync(icns1024, path.join(TAURI_DEV, "icon.icns"))
  } catch {
    copyFileSync(icns1024, path.join(TAURI_DEV, "icon.icns"))
  }
  unlinkSync(icns1024)

  console.log()
  console.log("Done! All icons regenerated from logo.png")
}

main().catch(console.error)
