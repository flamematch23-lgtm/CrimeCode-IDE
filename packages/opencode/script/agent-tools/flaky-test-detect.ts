#!/usr/bin/env bun
/**
 * flaky-test-detect.ts — run a test command N times and report instability.
 *
 * Auto-detects the test runner (bun test / pnpm test / npm test / cargo
 * test / pytest / go test) from the project's manifests, runs it N times,
 * and produces a per-test pass/fail matrix. Tests that fail at least once
 * but pass at least once are flagged as flaky.
 *
 * Usage:
 *   bun flaky-test-detect.ts                    # 5 runs, auto-detect
 *   bun flaky-test-detect.ts -n 10              # 10 runs
 *   bun flaky-test-detect.ts --cmd "vitest run" # explicit runner
 *   bun flaky-test-detect.ts --filter foo.test  # passed to runner as -t pattern
 *   bun flaky-test-detect.ts --json             # machine-readable
 *
 * Exit code: 0 = no flakes, 1 = flakes found, 2 = bad input or all failed
 * (the latter usually means a wiring problem, not flakiness).
 *
 * Caveats:
 *   - We rely on the runner's verbose output. If you've configured a
 *     custom reporter, pass --cmd explicitly.
 *   - Some test names contain colons / special chars. We dedupe on the
 *     raw test ID line so the reporter format is the source of truth.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { argv } from "node:process"

const args = argv.slice(2)
const json = args.includes("--json")
const runs = parseFlag(args, "n", 5)
const filterArg = args.find((a) => a.startsWith("--filter="))?.split("=")[1]
const cmdArg = args.find((a) => a.startsWith("--cmd="))?.split("=")[1]

const runner = cmdArg ? { cmd: cmdArg, parser: parseGenericLine } : autoDetectRunner()
if (!runner) {
  console.error("✗ could not auto-detect test runner (looked for package.json/Cargo.toml/go.mod/pyproject.toml)")
  console.error("  pass --cmd \"your test command\" to run anyway.")
  process.exit(2)
}

const cmdToRun = filterArg ? appendFilter(runner.cmd, filterArg) : runner.cmd

const tally = new Map<string, { pass: number; fail: number; firstFailMsg?: string }>()
let totalPass = 0
let totalFail = 0
let runsWithErrors = 0

console.error(`Running ${runs}× : ${cmdToRun}\n`)

for (let i = 1; i <= runs; i++) {
  process.stderr.write(`run ${i}/${runs}: `)
  const t0 = Date.now()
  const out = spawnSync(cmdToRun, { shell: true, encoding: "utf8" })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  const text = (out.stdout ?? "") + "\n" + (out.stderr ?? "")
  const tests = runner.parser(text)
  if (tests.length === 0) runsWithErrors++
  let runPass = 0
  let runFail = 0
  for (const t of tests) {
    const slot = tally.get(t.name) ?? { pass: 0, fail: 0 }
    if (t.outcome === "pass") {
      slot.pass++
      runPass++
    } else {
      slot.fail++
      runFail++
      if (!slot.firstFailMsg && t.message) slot.firstFailMsg = t.message
    }
    tally.set(t.name, slot)
  }
  totalPass += runPass
  totalFail += runFail
  process.stderr.write(`  ${runPass} pass, ${runFail} fail (${dt}s)\n`)
}

const flakes: Array<{ name: string; pass: number; fail: number; firstFailMsg?: string }> = []
const consistentFails: Array<{ name: string; firstFailMsg?: string }> = []
for (const [name, slot] of tally) {
  if (slot.pass > 0 && slot.fail > 0) flakes.push({ name, ...slot })
  else if (slot.pass === 0 && slot.fail > 0) consistentFails.push({ name, firstFailMsg: slot.firstFailMsg })
}

if (json) {
  console.log(
    JSON.stringify(
      {
        runs,
        cmd: cmdToRun,
        totals: { pass: totalPass, fail: totalFail, runsWithErrors },
        flakyTests: flakes,
        consistentFailures: consistentFails,
      },
      null,
      2,
    ),
  )
} else {
  console.log()
  console.log(`# Flaky-test report — ${runs} run(s) of \`${cmdToRun}\``)
  console.log(`Total assertions: ${totalPass} pass / ${totalFail} fail across all runs.`)
  if (runsWithErrors > 0) console.log(`⚠️  ${runsWithErrors} run(s) produced no parsable test results.`)
  console.log()
  if (flakes.length === 0 && consistentFails.length === 0) {
    console.log("✅ Stable — no flakes detected.")
  } else {
    if (flakes.length > 0) {
      console.log(`🟡 ${flakes.length} flaky test(s) (passed and failed across runs):`)
      for (const f of flakes.sort((a, b) => b.fail - a.fail)) {
        console.log(`  ${f.name}  →  ${f.pass}P / ${f.fail}F`)
        if (f.firstFailMsg) console.log(`    msg: ${f.firstFailMsg.slice(0, 200)}`)
      }
      console.log()
    }
    if (consistentFails.length > 0) {
      console.log(`🔴 ${consistentFails.length} test(s) failed in every run (NOT flaky — broken):`)
      for (const f of consistentFails) {
        console.log(`  ${f.name}`)
        if (f.firstFailMsg) console.log(`    msg: ${f.firstFailMsg.slice(0, 200)}`)
      }
    }
  }
}

process.exit(flakes.length > 0 ? 1 : runsWithErrors === runs ? 2 : 0)

// ---------------------------------------------------------------------------
// Runner detection + parsers
// ---------------------------------------------------------------------------

interface TestResult {
  name: string
  outcome: "pass" | "fail"
  message?: string
}

function autoDetectRunner(): { cmd: string; parser: (s: string) => TestResult[] } | null {
  if (existsSync("package.json")) {
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8")) as {
        scripts?: Record<string, string>
        devDependencies?: Record<string, string>
        dependencies?: Record<string, string>
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      // Bun test
      if (existsSync("bun.lock") || existsSync("bun.lockb") || pkg.scripts?.test === "bun test") {
        return { cmd: "bun test --reporter=junit", parser: parseJunit }
      }
      // Vitest
      if (deps.vitest) return { cmd: "npx vitest run --reporter=verbose", parser: parseVitestLine }
      // Jest
      if (deps.jest) return { cmd: "npx jest --reporters=default", parser: parseJestLine }
      if (pkg.scripts?.test) return { cmd: pkg.scripts.test, parser: parseGenericLine }
    } catch {
      /* fall through */
    }
  }
  if (existsSync("Cargo.toml")) {
    return { cmd: "cargo test --quiet", parser: parseCargo }
  }
  if (existsSync("go.mod")) {
    return { cmd: "go test ./... -v", parser: parseGoTest }
  }
  if (existsSync("pyproject.toml") || existsSync("pytest.ini") || existsSync("setup.cfg")) {
    return { cmd: "pytest -q --tb=line", parser: parsePytest }
  }
  return null
}

function appendFilter(cmd: string, filter: string): string {
  // Best-effort filter injection. Most runners accept -t / --testNamePattern.
  if (cmd.includes("vitest") || cmd.includes("jest")) return `${cmd} -t "${filter}"`
  if (cmd.includes("pytest")) return `${cmd} -k "${filter}"`
  if (cmd.includes("cargo test")) return `${cmd} ${filter}`
  if (cmd.includes("go test")) return `${cmd} -run "${filter}"`
  if (cmd.includes("bun test")) return `${cmd} -t "${filter}"`
  return cmd
}

// Bun's --reporter=junit emits XML; we parse a permissive subset.
function parseJunit(text: string): TestResult[] {
  const out: TestResult[] = []
  const re =
    /<testcase[^>]*name="([^"]+)"[^>]*classname="([^"]*)"[^>]*?>(?:([\s\S]*?)<\/testcase>)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = `${m[2] ? m[2] + " > " : ""}${m[1]}`
    const inner = m[3] ?? ""
    const failure = /<(failure|error)\b[^>]*message="([^"]*)"/.exec(inner)
    if (failure) out.push({ name, outcome: "fail", message: failure[2] })
    else out.push({ name, outcome: "pass" })
  }
  return out
}

function parseVitestLine(text: string): TestResult[] {
  // ✓ src/foo.test.ts > suite > test name (1ms)
  // ✗ src/foo.test.ts > suite > test name
  const out: TestResult[] = []
  for (const line of text.split("\n")) {
    const ok = /^\s*[✓✔]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/.exec(line)
    if (ok) {
      out.push({ name: ok[1].trim(), outcome: "pass" })
      continue
    }
    const bad = /^\s*[✗✘×]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/.exec(line)
    if (bad) out.push({ name: bad[1].trim(), outcome: "fail" })
  }
  return out
}

function parseJestLine(text: string): TestResult[] {
  // Same look as vitest essentially; share the parser.
  return parseVitestLine(text)
}

function parsePytest(text: string): TestResult[] {
  const out: TestResult[] = []
  for (const line of text.split("\n")) {
    const m = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED)/.exec(line)
    if (!m) continue
    if (m[2] === "PASSED") out.push({ name: m[1], outcome: "pass" })
    else if (m[2] === "FAILED" || m[2] === "ERROR") out.push({ name: m[1], outcome: "fail" })
  }
  return out
}

function parseCargo(text: string): TestResult[] {
  // Cargo prints `test foo::bar ... ok` or `... FAILED`.
  const out: TestResult[] = []
  for (const line of text.split("\n")) {
    const m = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)/.exec(line)
    if (!m) continue
    if (m[2] === "ok") out.push({ name: m[1], outcome: "pass" })
    else if (m[2] === "FAILED") out.push({ name: m[1], outcome: "fail" })
  }
  return out
}

function parseGoTest(text: string): TestResult[] {
  const out: TestResult[] = []
  for (const line of text.split("\n")) {
    const m = /^---\s+(PASS|FAIL):\s+(\S+)/.exec(line)
    if (!m) continue
    out.push({ name: m[2], outcome: m[1] === "PASS" ? "pass" : "fail" })
  }
  return out
}

function parseGenericLine(text: string): TestResult[] {
  // Last-ditch parser: lines that match "PASS|FAIL: name" or "✓|✗ name".
  return [...parseVitestLine(text), ...parseGenericPassFail(text)]
}

function parseGenericPassFail(text: string): TestResult[] {
  const out: TestResult[] = []
  for (const line of text.split("\n")) {
    const m = /^\s*(PASS|FAIL):\s+(.+)$/.exec(line)
    if (!m) continue
    out.push({ name: m[2].trim(), outcome: m[1] === "PASS" ? "pass" : "fail" })
  }
  return out
}

function parseFlag(args: string[], name: string, dflt: number): number {
  const idx = args.findIndex((x) => x === `-${name}` || x === `--${name}` || x.startsWith(`--${name}=`))
  if (idx < 0) return dflt
  const raw = args[idx].includes("=") ? args[idx].split("=")[1] : args[idx + 1]
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
