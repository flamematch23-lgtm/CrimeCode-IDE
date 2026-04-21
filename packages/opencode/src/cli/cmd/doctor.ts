import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Installation } from "../../installation"
import { Global } from "../../global"
import * as prompts from "@clack/prompts"
import path from "path"
import fs from "fs/promises"
import os from "os"

interface Check {
  name: string
  status: "ok" | "warn" | "fail"
  detail: string
}

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}

async function which(bin: string) {
  const ext = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  const dirs = (process.env.PATH || "").split(path.delimiter)
  for (const dir of dirs) {
    for (const e of ext) {
      const full = path.join(dir, bin + e)
      if (await exists(full)) return full
    }
  }
  return undefined
}

async function checkVersion(): Promise<Check> {
  return {
    name: "CLI Version",
    status: "ok",
    detail: `${Installation.VERSION} (${Installation.CHANNEL})`,
  }
}

async function checkRuntime(): Promise<Check> {
  const rt = typeof Bun !== "undefined" ? `Bun ${process.versions.bun}` : `Node ${process.version}`
  return { name: "Runtime", status: "ok", detail: rt }
}

async function checkPlatform(): Promise<Check> {
  return {
    name: "Platform",
    status: "ok",
    detail: `${os.platform()} ${os.arch()} (${os.release()})`,
  }
}

async function checkGit(): Promise<Check> {
  const p = await which("git")
  if (!p) return { name: "Git", status: "fail", detail: "not found in PATH" }
  try {
    const proc = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return { name: "Git", status: "ok", detail: out.trim() }
  } catch {
    return { name: "Git", status: "warn", detail: `found at ${p} but failed to run` }
  }
}

async function checkDirs(): Promise<Check> {
  const dirs = [
    { label: "data", path: Global.Path.data },
    { label: "config", path: Global.Path.config },
    { label: "cache", path: Global.Path.cache },
    { label: "state", path: Global.Path.state },
  ]
  const missing = []
  for (const d of dirs) {
    if (!(await exists(d.path))) missing.push(d.label)
  }
  if (missing.length > 0) return { name: "Data Dirs", status: "fail", detail: `missing: ${missing.join(", ")}` }
  return { name: "Data Dirs", status: "ok", detail: "all present" }
}

async function checkConfig(): Promise<Check> {
  const candidates = ["opencode.json", "opencode.jsonc"]
  for (const name of candidates) {
    const p = path.join(process.cwd(), name)
    if (await exists(p)) {
      try {
        const raw = await Bun.file(p).text()
        JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))
        return { name: "Project Config", status: "ok", detail: name }
      } catch {
        return { name: "Project Config", status: "warn", detail: `${name} exists but has syntax errors` }
      }
    }
  }
  return { name: "Project Config", status: "warn", detail: "no opencode.json found in cwd" }
}

async function checkKeys(): Promise<Check> {
  const vars = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AZURE_OPENAI_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "GITHUB_TOKEN",
    "COPILOT_API_KEY",
  ]
  const found = vars.filter((v) => !!process.env[v])
  if (found.length === 0) return { name: "API Keys", status: "warn", detail: "no known API key env vars set" }
  return { name: "API Keys", status: "ok", detail: `${found.length} key(s): ${found.join(", ")}` }
}

async function checkDisk(): Promise<Check> {
  try {
    const stat = await fs.statfs(Global.Path.data)
    const free = stat.bavail * stat.bsize
    const mb = Math.round(free / 1024 / 1024)
    if (mb < 100) return { name: "Disk Space", status: "fail", detail: `${mb} MB free (< 100 MB)` }
    if (mb < 500) return { name: "Disk Space", status: "warn", detail: `${mb} MB free (< 500 MB)` }
    return {
      name: "Disk Space",
      status: "ok",
      detail: `${mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB"} free`,
    }
  } catch {
    return { name: "Disk Space", status: "warn", detail: "could not determine" }
  }
}

async function checkExec(): Promise<Check> {
  return { name: "Executable", status: "ok", detail: process.execPath }
}

function render(checks: Check[]) {
  const width = 64
  const top = "\u250c" + "\u2500".repeat(width) + "\u2510"
  const mid = "\u251c" + "\u2500".repeat(width) + "\u2524"
  const bot = "\u2518"
  const left = "\u2514" + "\u2500".repeat(width) + bot

  const icon = (s: Check["status"]) => {
    if (s === "ok") return UI.Style.TEXT_SUCCESS + "\u2713" + UI.Style.TEXT_NORMAL
    if (s === "warn") return UI.Style.TEXT_WARNING + "!" + UI.Style.TEXT_NORMAL
    return UI.Style.TEXT_DANGER + "\u2717" + UI.Style.TEXT_NORMAL
  }

  console.log(top)
  console.log("\u2502" + "  CRIMECODE DOCTOR".padEnd(width) + "\u2502")
  console.log(mid)

  for (const c of checks) {
    const line = ` ${icon(c.status)}  ${c.name.padEnd(16)} ${c.detail}`
    // strip ansi for length calc
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "")
    const pad = Math.max(0, width - plain.length)
    console.log("\u2502" + line + " ".repeat(pad) + "\u2502")
  }

  console.log(left)
}

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "check system health and diagnose common issues",
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Doctor")

    const spinner = prompts.spinner()
    spinner.start("Running diagnostics...")

    const checks = await Promise.all([
      checkVersion(),
      checkRuntime(),
      checkPlatform(),
      checkExec(),
      checkGit(),
      checkDirs(),
      checkConfig(),
      checkKeys(),
      checkDisk(),
    ])

    spinner.stop("Diagnostics complete")
    console.log()
    render(checks)
    console.log()

    const fails = checks.filter((c) => c.status === "fail")
    const warns = checks.filter((c) => c.status === "warn")

    if (fails.length > 0) prompts.log.error(`${fails.length} issue(s) need attention`)
    else if (warns.length > 0) prompts.log.warn(`${warns.length} warning(s)`)
    else prompts.log.success("Everything looks good")

    prompts.outro("Done")
  },
})
