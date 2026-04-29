#!/usr/bin/env bun
/**
 * crypto-decoder.ts — Burp Suite Decoder equivalent.
 *
 * Encode / decode strings across the formats security work runs into
 * constantly: base64 (incl. URL-safe), URL, HTML entities, hex, ASCII
 * <-> bytes, JWT (decode), gzip, deflate.
 *
 * Smart mode auto-detects: paste a blob with --smart and the tool
 * tries to identify the format and shows the decoded value alongside
 * what gave it away ("base64-url, decoded as UTF-8 JSON").
 *
 * Usage:
 *   echo 'aGVsbG8=' | bun crypto-decoder.ts decode --format base64
 *   echo 'hello'    | bun crypto-decoder.ts encode --format base64
 *
 *   echo 'eyJhbGc...' | bun crypto-decoder.ts jwt-decode
 *
 *   echo '<unknown blob>' | bun crypto-decoder.ts smart
 *
 *   echo 'A=1&B=2'  | bun crypto-decoder.ts decode --format urlencoded
 *
 * Chain mode: --format=base64,base64,utf8 applies decoders in sequence
 * (handy when something is double-encoded).
 *
 * Output is RAW unless --json is set, so you can pipe straight into
 * jq / other tools.
 */
import { argv, stdin } from "node:process"
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib"

type Format =
  | "base64"
  | "base64url"
  | "url"
  | "urlencoded"
  | "html"
  | "hex"
  | "utf8"
  | "ascii"
  | "gzip"
  | "deflate"
  | "deflate-raw"

const args = argv.slice(2)
const op = args[0]
const json = args.includes("--json")

if (!op || ["--help", "-h"].includes(op)) usage(0)

const input = await readStdin()

if (op === "encode") {
  const fmts = parseFormats()
  let data: Buffer | string = input
  for (const f of fmts) data = encode(asBuffer(data), f)
  out(typeof data === "string" ? data : (data as Buffer).toString("utf8"))
} else if (op === "decode") {
  const fmts = parseFormats()
  let data: Buffer | string = input
  for (const f of fmts) data = decode(asBuffer(data), f)
  out(typeof data === "string" ? data : (data as Buffer).toString("utf8"))
} else if (op === "jwt-decode") {
  jwtDecode(input.trim())
} else if (op === "jwt-tamper") {
  jwtTamper(input.trim())
} else if (op === "jwt-verify") {
  await jwtVerify(input.trim())
} else if (op === "smart") {
  smartDetect(input.trim())
} else if (op === "hash") {
  doHash(input)
} else {
  usage(2)
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

function encode(buf: Buffer, fmt: Format): string {
  switch (fmt) {
    case "base64":
      return buf.toString("base64")
    case "base64url":
      return buf.toString("base64url")
    case "url":
      return encodeURIComponent(buf.toString("utf8"))
    case "urlencoded":
      // Treat input as already URL-encoded form data; encode each value.
      return buf
        .toString("utf8")
        .split("&")
        .map((kv) => {
          const eq = kv.indexOf("=")
          if (eq < 0) return encodeURIComponent(kv)
          return encodeURIComponent(kv.slice(0, eq)) + "=" + encodeURIComponent(kv.slice(eq + 1))
        })
        .join("&")
    case "html":
      return buf.toString("utf8").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    case "hex":
      return buf.toString("hex")
    case "utf8":
    case "ascii":
      return buf.toString(fmt as BufferEncoding)
    case "gzip":
    case "deflate":
    case "deflate-raw":
      throw new Error(`encoding ${fmt} not supported (decode-only)`)
  }
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

function decode(buf: Buffer, fmt: Format): Buffer {
  switch (fmt) {
    case "base64":
    case "base64url":
      return Buffer.from(buf.toString("utf8").trim(), fmt as BufferEncoding)
    case "url":
      return Buffer.from(decodeURIComponent(buf.toString("utf8")), "utf8")
    case "urlencoded":
      return Buffer.from(
        buf
          .toString("utf8")
          .split("&")
          .map((kv) => {
            const eq = kv.indexOf("=")
            if (eq < 0) return decodeURIComponent(kv)
            return decodeURIComponent(kv.slice(0, eq)) + "=" + decodeURIComponent(kv.slice(eq + 1))
          })
          .join("&"),
      )
    case "html":
      return Buffer.from(decodeHtmlEntities(buf.toString("utf8")), "utf8")
    case "hex":
      return Buffer.from(buf.toString("utf8").replace(/\s/g, ""), "hex")
    case "utf8":
    case "ascii":
      return buf
    case "gzip":
      return gunzipSync(buf)
    case "deflate":
      return inflateSync(buf)
    case "deflate-raw":
      return inflateRawSync(buf)
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
}

// ---------------------------------------------------------------------------
// JWT decode
// ---------------------------------------------------------------------------

function jwtDecode(token: string) {
  const parts = token.split(".")
  if (parts.length < 2) {
    console.error("✗ not a JWT (expected 2-3 dot-separated parts)")
    process.exit(2)
  }
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
  } catch {
    console.error("✗ JWT header is not valid JSON")
    process.exit(2)
  }
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    console.error("✗ JWT payload is not valid JSON")
    process.exit(2)
  }
  const sig = parts[2] ?? ""
  // Tampering / weak-alg flags
  const flags: string[] = []
  const alg = (header as { alg?: string })?.alg
  if (alg === "none" || alg === "None") flags.push("⚠ alg=none — signature optional/ignored")
  if (alg === "HS256" && sig.length === 0) flags.push("⚠ HS256 declared but signature is empty")
  if (typeof (header as { kid?: string })?.kid === "string" && (header as { kid: string }).kid.includes("..")) {
    flags.push("⚠ kid header looks like a path traversal")
  }
  const exp = (payload as { exp?: number })?.exp
  if (typeof exp === "number") {
    const remaining = exp - Math.floor(Date.now() / 1000)
    if (remaining < 0) flags.push(`⚠ token expired ${-remaining}s ago`)
    else if (remaining > 90 * 24 * 3600) flags.push(`⚠ token expires in ${(remaining / 86400).toFixed(0)} days — long-lived`)
  } else {
    flags.push("⚠ no `exp` claim — token never expires")
  }
  if (json) {
    console.log(JSON.stringify({ header, payload, signature: sig, flags }, null, 2))
  } else {
    console.log("# JWT decoded\n")
    console.log("Header:")
    console.log(JSON.stringify(header, null, 2))
    console.log("\nPayload:")
    console.log(JSON.stringify(payload, null, 2))
    console.log(`\nSignature (base64url): ${sig.length} chars`)
    if (flags.length > 0) {
      console.log(`\nFlags:`)
      for (const f of flags) console.log(`  ${f}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Smart mode — guess the format
// ---------------------------------------------------------------------------

function smartDetect(blob: string) {
  const guesses: Array<{ format: Format | "jwt"; confidence: number; decoded: string; note: string }> = []

  // JWT
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/.test(blob)) {
    try {
      const head = JSON.parse(Buffer.from(blob.split(".")[0], "base64url").toString("utf8"))
      guesses.push({
        format: "jwt",
        confidence: 0.95,
        decoded: JSON.stringify(head),
        note: "JWT — header decoded as JSON",
      })
    } catch {
      /* not JWT */
    }
  }

  // Hex
  if (/^[0-9a-fA-F\s]+$/.test(blob) && blob.replace(/\s/g, "").length % 2 === 0) {
    try {
      const dec = Buffer.from(blob.replace(/\s/g, ""), "hex")
      const txt = isPrintable(dec) ? dec.toString("utf8") : null
      guesses.push({
        format: "hex",
        confidence: txt ? 0.9 : 0.6,
        decoded: txt ?? `<binary, ${dec.length} bytes>`,
        note: txt ? "hex → printable UTF-8" : "hex → binary",
      })
    } catch {
      /* skip */
    }
  }

  // base64 / base64url
  if (/^[A-Za-z0-9+/=_-]+$/.test(blob) && blob.length % 4 <= 1) {
    for (const enc of ["base64", "base64url"] as const) {
      try {
        const dec = Buffer.from(blob, enc)
        if (dec.length === 0) continue
        const txt = isPrintable(dec) ? dec.toString("utf8") : null
        guesses.push({
          format: enc,
          confidence: txt ? 0.85 : 0.5,
          decoded: txt ?? `<binary, ${dec.length} bytes>`,
          note: txt ? `${enc} → printable UTF-8` : `${enc} → binary`,
        })
      } catch {
        /* skip */
      }
    }
  }

  // URL-encoded
  if (/%[0-9A-Fa-f]{2}/.test(blob)) {
    try {
      const dec = decodeURIComponent(blob)
      if (dec !== blob) {
        guesses.push({ format: "url", confidence: 0.8, decoded: dec, note: "URL-encoded → UTF-8" })
      }
    } catch {
      /* skip */
    }
  }

  // HTML entities
  if (/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/.test(blob)) {
    const dec = decodeHtmlEntities(blob)
    if (dec !== blob) {
      guesses.push({ format: "html", confidence: 0.75, decoded: dec, note: "HTML entities → UTF-8" })
    }
  }

  guesses.sort((a, b) => b.confidence - a.confidence)
  if (json) {
    console.log(JSON.stringify({ input: blob.slice(0, 200), guesses }, null, 2))
  } else {
    if (guesses.length === 0) {
      console.log("(no recognised encoding)")
      return
    }
    console.log(`# Smart decode — ${guesses.length} candidate(s)\n`)
    for (const g of guesses.slice(0, 5)) {
      console.log(`${g.format} (confidence ${(g.confidence * 100).toFixed(0)}%) — ${g.note}`)
      const preview = g.decoded.length > 400 ? g.decoded.slice(0, 400) + "…" : g.decoded
      console.log(`  ${preview}`)
      console.log()
    }
  }
}

function isPrintable(buf: Buffer): boolean {
  if (buf.length === 0) return false
  let printable = 0
  for (const b of buf) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++
  }
  return printable / buf.length > 0.85
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  // Allow the input to come from --input flag too — handy for short blobs.
  const fromFlag = parseFlag("input")
  if (fromFlag != null) return fromFlag

  const reader = (stdin as unknown as { stream(): ReadableStream<Uint8Array> }).stream
    ? (stdin as unknown as { stream(): ReadableStream<Uint8Array> }).stream().getReader()
    : null
  if (reader) {
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    stdin.on("data", (c) => chunks.push(c as Buffer))
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

function asBuffer(v: Buffer | string): Buffer {
  return typeof v === "string" ? Buffer.from(v, "utf8") : v
}

function out(s: string) {
  if (json) console.log(JSON.stringify({ output: s }))
  else process.stdout.write(s)
}

function parseFormats(): Format[] {
  const f = parseFlag("format")
  if (!f) bail("missing --format (e.g. base64, hex, base64,base64 for chained)")
  return (f as string).split(",").map((s) => s.trim() as Format)
}

function parseFlag(name: string): string | null {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (a) return a.slice(`--${name}=`.length)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1]
  return null
}

function bail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// JWT tampering — produce common attack variants
// ---------------------------------------------------------------------------

function jwtTamper(token: string) {
  const parts = token.split(".")
  if (parts.length < 2) {
    console.error("✗ not a JWT")
    process.exit(2)
  }
  const variants: Array<{ name: string; description: string; jwt: string }> = []
  let header: Record<string, unknown> = {}
  let payload: Record<string, unknown> = {}
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    console.error("✗ JWT header/payload not JSON")
    process.exit(2)
  }
  const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url")

  // alg=none variants
  variants.push({
    name: "alg-none",
    description: "Set alg=none, drop signature (RFC 7519 §6.1)",
    jwt: `${enc({ ...header, alg: "none" })}.${parts[1]}.`,
  })
  variants.push({
    name: "alg-None (mixed case)",
    description: "Some libraries do case-sensitive 'none' check",
    jwt: `${enc({ ...header, alg: "None" })}.${parts[1]}.`,
  })
  variants.push({
    name: "alg-NONE",
    description: "All-caps variant",
    jwt: `${enc({ ...header, alg: "NONE" })}.${parts[1]}.`,
  })

  // Privilege-escalation payload tweaks
  if ("admin" in payload || "isAdmin" in payload) {
    const p2 = { ...payload, admin: true, isAdmin: true }
    variants.push({
      name: "force-admin",
      description: "Set admin/isAdmin to true",
      jwt: `${parts[0]}.${enc(p2)}.${parts[2] ?? ""}`,
    })
  }
  if ("role" in payload) {
    const p2 = { ...payload, role: "admin" }
    variants.push({
      name: "role-admin",
      description: "Set role=admin",
      jwt: `${parts[0]}.${enc(p2)}.${parts[2] ?? ""}`,
    })
  }
  if ("sub" in payload) {
    variants.push({
      name: "sub-1",
      description: "Set sub=1 (often the admin/system user)",
      jwt: `${parts[0]}.${enc({ ...payload, sub: "1" })}.${parts[2] ?? ""}`,
    })
  }

  // Strip exp
  if ("exp" in payload) {
    const { exp: _exp, ...rest } = payload
    variants.push({
      name: "strip-exp",
      description: "Remove the exp claim — token never expires",
      jwt: `${parts[0]}.${enc(rest)}.${parts[2] ?? ""}`,
    })
  }

  // kid path-traversal
  variants.push({
    name: "kid-traversal",
    description: "kid header points at a known file (e.g. /dev/null) → empty key",
    jwt: `${enc({ ...header, kid: "../../../../dev/null" })}.${parts[1]}.AAAA`,
  })

  if (json) {
    console.log(JSON.stringify(variants, null, 2))
    return
  }
  console.log(`# JWT tamper variants (${variants.length})\n`)
  for (const v of variants) {
    console.log(`▸ ${v.name} — ${v.description}`)
    console.log(`  ${v.jwt}`)
    console.log()
  }
}

// ---------------------------------------------------------------------------
// JWT verify — verify with HS256 secret list
// ---------------------------------------------------------------------------

async function jwtVerify(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3) {
    console.error("✗ jwt-verify needs a full 3-part token")
    process.exit(2)
  }
  const wordlistPath = parseFlag("wordlist")
  const secrets: string[] = wordlistPath
    ? (await import("node:fs")).readFileSync(wordlistPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
    : ["secret", "password", "admin", "test", "your-256-bit-secret", "key", "jwt", "changeme"]

  const { createHmac, timingSafeEqual } = await import("node:crypto")
  const data = `${parts[0]}.${parts[1]}`
  const sig = Buffer.from(parts[2], "base64url")
  for (const s of secrets) {
    const expected = createHmac("sha256", s).update(data).digest()
    if (expected.length === sig.length && timingSafeEqual(expected, sig)) {
      const result = { matched: true, secret: s, algorithm: "HS256" }
      if (json) console.log(JSON.stringify(result))
      else console.log(`✓ HS256 secret found: '${s}'`)
      return
    }
  }
  if (json) console.log(JSON.stringify({ matched: false, tried: secrets.length }))
  else console.log(`✗ no HS256 secret matched (${secrets.length} tried)`)
}

// ---------------------------------------------------------------------------
// Hash — fingerprint or compute
// ---------------------------------------------------------------------------

async function doHash(text: string) {
  const algRaw = parseFlag("algorithm") ?? parseFlag("alg") ?? "sha256"
  const { createHash } = await import("node:crypto")
  const buf = Buffer.from(text, "utf8")
  const algorithms = algRaw === "all" ? ["md5", "sha1", "sha256", "sha384", "sha512"] : [algRaw]
  const result: Record<string, string> = {}
  for (const a of algorithms) {
    try {
      result[a] = createHash(a).update(buf).digest("hex")
    } catch (e) {
      result[a] = `error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (json) console.log(JSON.stringify(result, null, 2))
  else for (const [k, v] of Object.entries(result)) console.log(`${k.padEnd(8)} ${v}`)
}

function usage(code: number): never {
  console.error(`crypto-decoder.ts <op> [flags]

Ops:
  encode       stdin → encoded; --format <fmt>
  decode       stdin → decoded; --format <fmt>
  jwt-decode   stdin → JWT header + payload + flags
  jwt-tamper   stdin → list of common attack variants (alg-none, role bumps…)
  jwt-verify   stdin → try HS256 secrets to verify the signature
                       --wordlist FILE   (default: built-in shortlist)
  smart        stdin → format guess(es) + decoded preview
  hash         stdin → cryptographic hash; --algorithm md5|sha1|sha256|sha512|all

Formats: base64, base64url, url, urlencoded, html, hex, utf8, ascii,
         gzip, deflate, deflate-raw  (chain with comma: base64,base64,utf8)

Common: --json, --input <string>
`)
  process.exit(code)
}
