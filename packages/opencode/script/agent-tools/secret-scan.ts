#!/usr/bin/env bun
/**
 * secret-scan.ts — find hardcoded secrets in a diff or working tree.
 *
 * Detects the high-confidence secret patterns that gitleaks / trufflehog
 * catch — AWS keys, GitHub tokens, Slack webhooks, JWT, private keys,
 * API key formats, etc. — using regex + entropy gate. Designed to be
 * called from `pre-commit-review` BEFORE a commit lands, but works
 * standalone too.
 *
 * Why a tool rather than just running gitleaks: this ships in the repo,
 * has zero install (single TS file), and surfaces the same matches
 * gitleaks would. Trade-off: we miss the long tail of obscure formats
 * gitleaks knows about. For belt-and-braces, run both.
 *
 * Usage:
 *   bun secret-scan.ts                       # staged diff (default)
 *   bun secret-scan.ts --diff=HEAD~5..HEAD   # specific git range
 *   bun secret-scan.ts --tree                # whole working tree
 *   bun secret-scan.ts --files file1 file2   # explicit files
 *   bun secret-scan.ts --json                # machine output
 *   bun secret-scan.ts --allow-list .secret-scan-ignore   # path patterns to skip
 *
 * Exit code: 0 = clean, 1 = secrets found, 2 = bad input.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { argv } from "node:process"

interface Hit {
  file: string
  line: number
  rule: string
  preview: string
}

const args = argv.slice(2)
const json = args.includes("--json")
const tree = args.includes("--tree")
const filesArg = parseFlag(args, "files")
const diffRange = parseFlag(args, "diff")
const allowFile = parseFlag(args, "allow-list") ?? defaultAllowFile()

// ---------------------------------------------------------------------------
// Rules — ordered roughly by hit-rate. Each rule is a regex + a label +
// optional minimum entropy on the matched group.
// ---------------------------------------------------------------------------

interface Rule {
  name: string
  // Pattern. If a capturing group is present, the secret material must
  // be in group 1; we entropy-check that group.
  pattern: RegExp
  minEntropy?: number
}

const RULES: Rule[] = [
  // AWS
  { name: "AWS Access Key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS Secret", pattern: /(?:aws[_\-\s]?(?:secret|sk)[_\-\s]?(?:access[_\-\s]?)?key)["'\s:=]+([A-Za-z0-9/+=]{40})/i, minEntropy: 4.2 },

  // GitHub
  { name: "GitHub Personal Access Token (classic)", pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub OAuth Token", pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub User Token (server-to-server)", pattern: /\bghu_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub Server Token (app)", pattern: /\bghs_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub Refresh Token", pattern: /\bghr_[A-Za-z0-9]{76}\b/ },
  { name: "GitHub Fine-grained Token", pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },

  // Slack
  { name: "Slack Token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,72}\b/ },
  { name: "Slack Webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,12}\/B[A-Z0-9]{8,12}\/[A-Za-z0-9]{24}/ },

  // Stripe
  { name: "Stripe Secret Key", pattern: /\bsk_(?:test|live)_[A-Za-z0-9]{24,}\b/ },
  { name: "Stripe Restricted Key", pattern: /\brk_(?:test|live)_[A-Za-z0-9]{24,}\b/ },

  // Google / Firebase
  { name: "Google API Key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Google OAuth Refresh Token", pattern: /\b1\/\/[0-9A-Za-z_-]{43,}\b/ },
  { name: "Firebase Cloud Messaging Key", pattern: /\bAAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140,}\b/ },

  // Generic JWT
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },

  // Private keys
  { name: "PEM Private Key", pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED |)PRIVATE KEY( BLOCK)?-----/ },

  // Telegram
  { name: "Telegram Bot Token", pattern: /\b\d{9,11}:[A-Za-z0-9_-]{35}\b/ },

  // Discord
  { name: "Discord Bot Token", pattern: /\b[MN][A-Za-z0-9-_]{23}\.[A-Za-z0-9-_]{6}\.[A-Za-z0-9-_]{27}\b/ },

  // Twilio
  { name: "Twilio Account SID", pattern: /\bAC[a-f0-9]{32}\b/ },
  { name: "Twilio Auth Token", pattern: /\bSK[a-f0-9]{32}\b/ },

  // OpenAI / Anthropic
  { name: "OpenAI API Key", pattern: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/ },
  { name: "Anthropic API Key", pattern: /\bsk-ant-(?:api|sid|admin)[0-9]{2,}-[A-Za-z0-9_-]{80,}\b/ },

  // Brave / SerpApi / SearXNG
  { name: "Brave Search API Key", pattern: /\bBSA[A-Za-z0-9]{20,}\b/ },

  // Generic high-entropy assignments — last-ditch catch
  {
    name: "Generic high-entropy secret (assignment)",
    pattern:
      /(?:secret|token|password|api[_\-]?key|access[_\-]?key|private[_\-]?key)["'\s:=]+["']([A-Za-z0-9_/+\-=]{32,})["']/i,
    minEntropy: 4.5,
  },
]

// ---------------------------------------------------------------------------
// Allow-list: a path glob list (one per line) for files we KNOW contain
// fixtures / test data and shouldn't trip the scanner. Default file:
// `.secret-scan-ignore` at repo root if it exists.
// ---------------------------------------------------------------------------

const allowPatterns = loadAllowList(allowFile)

function defaultAllowFile(): string | null {
  return existsSync(".secret-scan-ignore") ? ".secret-scan-ignore" : null
}

function loadAllowList(p: string | null): RegExp[] {
  if (!p || !existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((g) => new RegExp("^" + g.replace(/[.+^$|(){}\[\]]/g, "\\$&").replace(/\*/g, ".*") + "$"))
}

function isAllowed(path: string): boolean {
  return allowPatterns.some((re) => re.test(path))
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

function getStagedFiles(): string[] {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" })
  return (r.stdout ?? "").split("\n").filter(Boolean)
}

function getRangeFiles(range: string): string[] {
  const r = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACM", range], { encoding: "utf8" })
  return (r.stdout ?? "").split("\n").filter(Boolean)
}

function getTreeFiles(): string[] {
  // ls-files respects .gitignore; -c (cached) + -m (modified) + -o
  // (others) covers tracked + untracked + dirty.
  const r = spawnSync("git", ["ls-files", "-comz", "--exclude-standard"], { encoding: "utf8" })
  return (r.stdout ?? "").split("\0").filter(Boolean)
}

function getStagedDiff(file: string): string {
  // We scan the +added side of the diff (so deletions don't count).
  const r = spawnSync("git", ["diff", "--cached", "-U0", "--no-color", "--", file], { encoding: "utf8" })
  return extractAdditions(r.stdout ?? "")
}

function getRangeDiff(range: string, file: string): string {
  const r = spawnSync("git", ["diff", "-U0", "--no-color", range, "--", file], { encoding: "utf8" })
  return extractAdditions(r.stdout ?? "")
}

function extractAdditions(diff: string): string {
  const out: string[] = []
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1))
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function shannonEntropy(s: string): number {
  if (!s) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  const len = s.length
  let h = 0
  for (const c of counts.values()) {
    const p = c / len
    h -= p * Math.log2(p)
  }
  return h
}

function scan(text: string, file: string): Hit[] {
  const hits: Hit[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 1024) continue // skip minified/build artefacts
    for (const rule of RULES) {
      const m = rule.pattern.exec(line)
      if (!m) continue
      const secretMaterial = m[1] ?? m[0]
      if (rule.minEntropy && shannonEntropy(secretMaterial) < rule.minEntropy) continue
      // Common-sense filters: dummy/test placeholders.
      if (/\b(?:example|test|fake|dummy|placeholder|xxxx|YOUR_|<.+>)\b/i.test(line)) continue
      hits.push({
        file,
        line: i + 1,
        rule: rule.name,
        preview: line.length > 220 ? line.slice(0, 220) + "…" : line,
      })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let files: string[]
let getText: (f: string) => string

if (filesArg) {
  files = filesArg.split(",").map((s) => s.trim()).filter(Boolean)
  getText = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "")
} else if (tree) {
  files = getTreeFiles()
  getText = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "")
} else if (diffRange) {
  files = getRangeFiles(diffRange)
  getText = (f) => getRangeDiff(diffRange, f)
} else {
  files = getStagedFiles()
  getText = (f) => getStagedDiff(f)
}

// Skip binary files + large files + lockfiles + node_modules.
const skipExt = /\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mov|wasm|asar|lockb)$/i
const skipPath = /(?:^|\/)(?:node_modules|dist|out|target|\.git|coverage|\.next|\.turbo)\//
const filtered = files.filter((f) => !skipExt.test(f) && !skipPath.test(f) && !isAllowed(f))

if (filtered.length === 0 && !json) {
  console.log("(nothing to scan)")
  process.exit(0)
}

const allHits: Hit[] = []
for (const f of filtered) {
  let text: string
  try {
    text = getText(f)
  } catch {
    continue
  }
  if (!text) continue
  for (const h of scan(text, f)) allHits.push(h)
}

if (json) {
  console.log(JSON.stringify({ scanned: filtered.length, hits: allHits }, null, 2))
} else {
  if (allHits.length === 0) {
    console.log(`✅ Clean — scanned ${filtered.length} file(s), no secrets detected.`)
  } else {
    console.log(`🔴 ${allHits.length} potential secret(s) found in ${filtered.length} file(s):\n`)
    for (const h of allHits) {
      console.log(`${h.file}:${h.line}  [${h.rule}]`)
      console.log(`  ${h.preview}`)
      console.log()
    }
    console.log(`If a hit is a false positive (test fixture, public sample, etc.), add the path glob to`)
    console.log(`.secret-scan-ignore at the repo root. Otherwise: rotate the secret IMMEDIATELY before`)
    console.log(`removing it from history (\`git filter-repo\` / GitHub support).`)
  }
}

process.exit(allHits.length > 0 ? 1 : 0)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlag(args: string[], name: string): string | null {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(`--${name}=`.length) : null
}
