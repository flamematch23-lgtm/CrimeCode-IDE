#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { binaryPath, copyBinaryToSidecarFolder, getCurrentSidecar, hostTarget, sidecarPath } from "./utils"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string", default: "check" },
    channel: { type: "string", default: "prod" },
    target: { type: "string" },
    "artifact-dir": { type: "string" },
    "artifact-name": { type: "string", default: "opencode-cli" },
    kill: { type: "boolean", default: false },
    "run-id": { type: "string" },
    "skip-clean": { type: "boolean", default: false },
    "skip-cli": { type: "boolean", default: false },
    "no-sign": { type: "boolean", default: false },
  },
})

const mode = parseMode(values.mode)
const chan = parseChan(values.channel)
const target = values.target ?? Bun.env.RUST_TARGET ?? Bun.env.TAURI_ENV_TARGET_TRIPLE ?? hostTarget()
const dir = path.resolve(import.meta.dirname, "..")
const cliDir = path.resolve(dir, "../opencode")
const side = getCurrentSidecar(target)
const cfg = config(chan)
const rust = path.join(dir, "src-tauri", "target", target)
const rel = path.join(rust, "release")
const bundle = path.join(rel, "bundle")
const file = path.resolve(dir, binaryPath(target))

process.chdir(dir)

// NO_SIGN: allow local development without signing artifacts
async function ensureSigningKeys() {
  const keyEnv = process.env.TAURI_SIGNING_PRIVATE_KEY
  if (keyEnv && keyEnv.trim().length > 0) {
    console.log("[signing] TAURI_SIGNING_PRIVATE_KEY provided via env");
    return
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    path.join(home, ".tauri", "crimecode.key"),
    path.join("C:\\Users\\mango", ".tauri", "crimecode.key"),
  ];

  for (const p of candidates) {
    try {
      await fs.access(p)
      const key = await fs.readFile(p, "utf8")
      process.env.TAURI_SIGNING_PRIVATE_KEY = key
      console.log(`[signing] loaded private key from ${p}`)
      return
    } catch {
      // ignore
    }
  }

  console.warn(
    "[signing] TAURI_SIGNING_PRIVATE_KEY not set; signing may fail for prod config. To enable signing locally, provide a private key and its password via TAURI_SIGNING_PRIVATE_KEY/TAURI_SIGNING_PRIVATE_KEY_PASSWORD."
  )
}

if (values["no-sign"]) {
  console.log("[release] NO_SIGN enabled: skipping signing keys load");
} else {
  await ensureSigningKeys()
}

console.log(`[release] mode=${mode} channel=${chan} target=${target}`)
console.log(`[release] sidecar=${sidecarPath(target)}`)

await syncVersion()

if (mode === "sync") {
  if (!values["skip-cli"]) await syncCli()
  console.log("[release] sync complete")
  process.exit(0)
}

if (!values["skip-cli"]) {
  await buildCli()
  await smokeCli()
  await copyBinaryToSidecarFolder(file, target)
}

if (mode === "check") {
  await run(["bun", "run", "build"])
  await run(["cargo", "check", "--manifest-path", "src-tauri/Cargo.toml", "--target", target])
  console.log("[release] check complete")
  process.exit(0)
}

if (values.kill) await killWindows()
if (!values["skip-clean"]) await clean()

await run(["bun", "run", "tauri", "build", "--config", cfg, "--target", target, "--verbose"])
await writeManifest()

console.log("[release] bundle complete")

function parseMode(mode: string) {
  if (mode === "check" || mode === "bundle" || mode === "sync") return mode
  throw new Error(`Invalid mode '${mode}'. Use 'check', 'bundle', or 'sync'.`)
}

function parseChan(chan: string) {
  if (chan === "dev" || chan === "beta" || chan === "prod") return chan
  throw new Error(`Invalid channel '${chan}'. Use 'dev', 'beta', or 'prod'.`)
}

function config(chan: "dev" | "beta" | "prod") {
  if (chan === "dev") return "src-tauri/tauri.conf.json"
  if (chan === "beta") return "src-tauri/tauri.beta.conf.json"
  return "src-tauri/tauri.prod.conf.json"
}

async function run(cmd: string[], cwd = dir, pipe = false) {
  console.log(`[run] ${cmd.join(" ")}`)
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: pipe ? "pipe" : "inherit",
    stderr: pipe ? "pipe" : "inherit",
    env: process.env,
  })
  const code = await proc.exited
  const out = pipe ? await new Response(proc.stdout).text() : ""
  const err = pipe ? await new Response(proc.stderr).text() : ""
  if (code !== 0) {
    const tail = err.trim() || out.trim()
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}${tail ? `\n${tail}` : ""}`)
  }
  return out
}

async function buildCli() {
  const cmd = ["bun", "run", "script/build.ts", "--single", "--skip-embed-web-ui"]
  if (side.ocBinary.includes("-baseline")) cmd.push("--baseline")
  await run(cmd, cliDir)
  await fs.access(file)
}

async function syncVersion() {
  const version = process.env.OPENCODE_VERSION
  if (!version) return

  const pkg = path.join(dir, "package.json")
  const json = await Bun.file(pkg).json()
  if (json.version === version) return
  json.version = version
  await Bun.write(pkg, JSON.stringify(json, null, 2) + "\n")
  console.log(`[release] version=${version}`)
}

async function syncCli() {
  const root = path.resolve(dir, values["artifact-dir"] ?? "src-tauri/target/opencode-binaries")
  if (!values["artifact-dir"]) {
    const runId = values["run-id"] ?? Bun.env.GITHUB_RUN_ID
    if (!runId) throw new Error("GITHUB_RUN_ID or --run-id is required for sync mode")
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
    await run(["gh", "run", "download", runId, "-n", values["artifact-name"]], root)
  }

  const name = side.rustTarget.includes("windows") ? "opencode.exe" : "opencode"
  const source = path.join(root, side.ocBinary, "bin", name)
  await fs.access(source)
  await copyBinaryToSidecarFolder(source, target)
}

async function smokeCli() {
  const out = await run([file, "--version"], dir, true)
  console.log(`[release] cli=${out.trim()}`)
}

async function killWindows() {
  if (process.platform !== "win32") return
  for (const name of ["OpenCode.exe", path.basename(sidecarPath(target))]) {
    const proc = Bun.spawn(["taskkill", "/F", "/T", "/IM", name], {
      cwd: dir,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    await proc.exited
  }
}

async function clean() {
  await drop(bundle)

  const list = await fs.readdir(rel).catch(() => [])
  for (const name of list) {
    if (!name.startsWith("OpenCode")) continue
    await drop(path.join(rel, name))
  }
}

async function drop(file: string) {
  await fs.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }).catch((err) => {
    throw new Error(
      `Failed to remove '${file}': ${err instanceof Error ? err.message : String(err)}. Close running OpenCode or retry with --kill.`,
    )
  })
}

async function writeManifest() {
  const list = await scan(bundle)
  const items = await Promise.all(
    list.map(async (file) => ({
      file: path.relative(bundle, file).replaceAll("\\", "/"),
      size: (await fs.stat(file)).size,
      sha256: await sum(file),
    })),
  )
  const out = path.join(dir, "src-tauri", "target", `release-${chan}-${target}.json`)
  await Bun.write(
    out,
    JSON.stringify(
      {
        channel: chan,
        target,
        sidecar: sidecarPath(target),
        generated_at: new Date().toISOString(),
        items,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(`[release] manifest=${path.relative(dir, out)}`)
}

async function scan(dir: string): Promise<string[]> {
  const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = await Promise.all(
    list.map(async (item) => {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) return scan(file)
      return [file]
    }),
  )
  return out.flat()
}

async function sum(file: string) {
  const hash = createHash("sha256")
  hash.update(Buffer.from(await Bun.file(file).arrayBuffer()))
  return hash.digest("hex")
}
