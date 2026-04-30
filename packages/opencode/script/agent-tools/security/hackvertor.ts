#!/usr/bin/env bun
/**
 * hackvertor.ts — Hackvertor extension equivalent.
 *
 * Tag-based, chainable encode/decode/transform engine. Wrap any region
 * of input in a `<@tag>...<@/tag>` and the engine resolves the inner
 * region recursively, then applies the transformation.
 *
 * Tags supported (closing form `<@/name>`):
 *
 *   Encoders (innermost-first):
 *     base64, base64url, hex, url, urldouble, html, htmldec, htmlhex,
 *     htmldechex, decimal_entities, octal_entities, json_string,
 *     css_escape, js_string, unicode_escape, utf16_escape, mysql_hex
 *
 *   Decoders:
 *     d_base64, d_base64url, d_hex, d_url, d_html
 *
 *   Hashes:
 *     md5, sha1, sha256, sha512, hmac_sha256(key)
 *
 *   Compression:
 *     gzip, deflate
 *
 *   Random / generators:
 *     random_int(min,max), random_string(n), uuid
 *
 *   Misc:
 *     reverse, upper, lower, length
 *
 * Usage:
 *   echo '<@base64><@hex>aGVsbG8=<@/hex><@/base64>'  | bun hackvertor.ts encode
 *   echo '<@d_base64>aGVsbG8=<@/d_base64>'            | bun hackvertor.ts encode
 *   echo '{"x":1}'                                     | bun hackvertor.ts wrap --tag base64
 *   bun hackvertor.ts list                              # show every available tag
 *
 * Why tags? When generating fuzz payloads or attack strings the same
 * blob may need to be wrapped in 3-4 layers of encoding. Tags let the
 * agent describe the structure in a single readable string instead of
 * threading multiple shell pipes.
 */
import { argv } from "node:process"
import { createHash, createHmac, randomBytes, randomUUID, randomInt } from "node:crypto"
import { gzipSync, deflateSync } from "node:zlib"
import { makeArgs, bail, readStdin } from "./_lib/common.ts"

const cli = makeArgs(argv)
const cmd = cli.args[0] ?? "encode"
if (["--help", "-h"].includes(cmd)) usage(0)

if (cmd === "list") {
  cmdList()
} else if (cmd === "encode" || cmd === "transform" || cmd === "decode") {
  const text = await readStdin()
  const out = transform(text)
  process.stdout.write(out)
} else if (cmd === "wrap") {
  const tag = cli.required("tag")
  const text = await readStdin()
  process.stdout.write(`<@${tag}>${text}<@/${tag}>`)
} else usage(2)

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type Handler = (inner: string, args: string[]) => string

const HANDLERS: Record<string, Handler> = {
  // Encoders
  base64: (s) => Buffer.from(s, "utf8").toString("base64"),
  base64url: (s) => Buffer.from(s, "utf8").toString("base64url"),
  hex: (s) => Buffer.from(s, "utf8").toString("hex"),
  url: (s) => encodeURIComponent(s),
  urldouble: (s) => encodeURIComponent(encodeURIComponent(s)),
  html: (s) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  htmldec: (s) => [...s].map((c) => `&#${c.codePointAt(0)};`).join(""),
  htmlhex: (s) => [...s].map((c) => `&#x${c.codePointAt(0)!.toString(16)};`).join(""),
  htmldechex: (s) =>
    [...s]
      .map((c, i) => (i % 2 === 0 ? `&#${c.codePointAt(0)};` : `&#x${c.codePointAt(0)!.toString(16)};`))
      .join(""),
  decimal_entities: (s) => [...s].map((c) => `&#${c.codePointAt(0)};`).join(""),
  octal_entities: (s) => [...s].map((c) => `\\${c.codePointAt(0)!.toString(8)}`).join(""),
  json_string: (s) => JSON.stringify(s),
  css_escape: (s) =>
    s.replace(/./g, (c) =>
      /[a-zA-Z0-9]/.test(c) ? c : `\\${c.charCodeAt(0).toString(16)} `,
    ),
  js_string: (s) =>
    s.replace(/./g, (c) => {
      const code = c.charCodeAt(0)
      if (code < 32 || code > 126 || c === "\\" || c === '"' || c === "'") return `\\u${code.toString(16).padStart(4, "0")}`
      return c
    }),
  unicode_escape: (s) =>
    [...s].map((c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`).join(""),
  utf16_escape: (s) =>
    [...s]
      .flatMap((c) => {
        const code = c.codePointAt(0)!
        if (code <= 0xffff) return [code]
        const hi = ((code - 0x10000) >> 10) + 0xd800
        const lo = ((code - 0x10000) & 0x3ff) + 0xdc00
        return [hi, lo]
      })
      .map((n) => `\\u${n.toString(16).padStart(4, "0")}`)
      .join(""),
  mysql_hex: (s) => "0x" + Buffer.from(s, "utf8").toString("hex"),

  // Decoders
  d_base64: (s) => Buffer.from(s.trim(), "base64").toString("utf8"),
  d_base64url: (s) => Buffer.from(s.trim(), "base64url").toString("utf8"),
  d_hex: (s) => Buffer.from(s.replace(/\s/g, ""), "hex").toString("utf8"),
  d_url: (s) => decodeURIComponent(s),
  d_html: (s) => decodeHtmlEntities(s),

  // Hashes
  md5: (s) => createHash("md5").update(s).digest("hex"),
  sha1: (s) => createHash("sha1").update(s).digest("hex"),
  sha256: (s) => createHash("sha256").update(s).digest("hex"),
  sha512: (s) => createHash("sha512").update(s).digest("hex"),
  hmac_sha256: (s, args) => createHmac("sha256", args[0] ?? "").update(s).digest("hex"),

  // Compression (returns base64 since binary blobs don't survive utf8 round-trip)
  gzip: (s) => gzipSync(Buffer.from(s, "utf8")).toString("base64"),
  deflate: (s) => deflateSync(Buffer.from(s, "utf8")).toString("base64"),

  // Random
  random_int: (_, args) => {
    const min = Number(args[0] ?? 0)
    const max = Number(args[1] ?? 100)
    return String(randomInt(min, max))
  },
  random_string: (_, args) => {
    const n = Number(args[0] ?? 16)
    return randomBytes(Math.ceil(n / 2))
      .toString("hex")
      .slice(0, n)
  },
  uuid: () => randomUUID(),

  // Misc
  reverse: (s) => [...s].reverse().join(""),
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  length: (s) => String(s.length),
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

// Resolve innermost tags first. We scan for `<@name(args?)>...<@/name>` and
// recursively resolve, repeating until no tags remain or a fixed-point hits.
function transform(input: string): string {
  let s = input
  for (let i = 0; i < 64; i++) {
    const re = /<@([a-z_]+)(?:\(([^)]*)\))?>(((?!<@[a-z_]+).)*?)<@\/\1>/s
    const m = re.exec(s)
    if (!m) break
    const name = m[1]
    const argsRaw = m[2] ?? ""
    const inner = m[3]
    const handler = HANDLERS[name]
    if (!handler) {
      // unknown tag — leave it alone, advance past it to avoid infinite loop
      s = s.slice(0, m.index) + `[unknown tag: ${name}]` + s.slice(m.index + m[0].length)
      continue
    }
    const args = argsRaw
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
    const replaced = handler(inner, args)
    s = s.slice(0, m.index) + replaced + s.slice(m.index + m[0].length)
  }
  return s
}

function cmdList() {
  if (cli.has("--json")) {
    console.log(JSON.stringify(Object.keys(HANDLERS).sort(), null, 2))
    return
  }
  console.log(`# Hackvertor tags\n`)
  const groups = {
    Encoders: ["base64", "base64url", "hex", "url", "urldouble", "html", "htmldec", "htmlhex", "htmldechex", "decimal_entities", "octal_entities", "json_string", "css_escape", "js_string", "unicode_escape", "utf16_escape", "mysql_hex"],
    Decoders: ["d_base64", "d_base64url", "d_hex", "d_url", "d_html"],
    Hashes: ["md5", "sha1", "sha256", "sha512", "hmac_sha256"],
    Compression: ["gzip", "deflate"],
    Generators: ["random_int", "random_string", "uuid"],
    Misc: ["reverse", "upper", "lower", "length"],
  }
  for (const [g, tags] of Object.entries(groups)) {
    console.log(`## ${g}`)
    for (const t of tags) console.log(`  <@${t}>...<@/${t}>`)
    console.log()
  }
  console.log(`Tags can take args via parens: <@hmac_sha256(my-secret)>payload<@/hmac_sha256>`)
  console.log(`Tags nest: <@base64><@hex>hello<@/hex><@/base64>`)
}

// ---------------------------------------------------------------------------

function usage(code: number): never {
  console.error(`hackvertor.ts <command> [flags]

Tag-based chainable encode/decode/transform engine.

Commands:
  encode      stdin → output (alias: transform, decode)
  wrap        stdin → "<@TAG>stdin<@/TAG>"   (--tag NAME)
  list        print every supported tag

Examples:
  echo 'hello' | hackvertor.ts encode --tag base64       # via wrap
  echo '<@base64>hello<@/base64>' | hackvertor.ts encode # explicit
  echo '<@base64><@hex>hi<@/hex><@/base64>' | hackvertor.ts encode

Common: --json (with list)
`)
  process.exit(code)
}
