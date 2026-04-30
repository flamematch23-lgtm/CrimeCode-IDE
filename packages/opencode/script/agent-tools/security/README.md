# Security Toolkit — Burp Suite Pro–style suite

Single-file `bun` scripts that mirror the surfaces you'd reach for in
**Burp Suite Professional**, plus an AI agent tool wrapper
(`burp_toolkit`) so the model can drive any of them during a task.

## What's in the box

| Tool | Burp Suite equivalent | Script |
|---|---|---|
| HTTP Intercept Proxy + History DB + Control REST API | Proxy / HTTP history / Match-and-Replace | [`http-proxy.ts`](http-proxy.ts) |
| Repeater | Repeater | [`http-repeater.ts`](http-repeater.ts) |
| Intruder (sniper / battering / pitchfork / clusterbomb) | Intruder | [`http-fuzzer.ts`](http-fuzzer.ts) |
| Decoder + JWT decode/tamper/verify + smart-detect | Decoder / JWT Editor | [`crypto-decoder.ts`](crypto-decoder.ts) |
| Comparer (line/word/byte/JSON/headers) | Comparer | [`http-comparer.ts`](http-comparer.ts) |
| Sequencer (entropy + FIPS-loose) | Sequencer | [`token-sequencer.ts`](token-sequencer.ts) |
| Scanner (passive + active) | Scanner | [`vuln-scanner.ts`](vuln-scanner.ts) |
| Site map / Crawler | Site map / Target | [`site-crawler.ts`](site-crawler.ts) |
| Hidden parameter discovery | Param Miner extension | [`param-miner.ts`](param-miner.ts) |
| OOB callback HTTP/DNS server | Burp Collaborator | [`collaborator.ts`](collaborator.ts) |
| CSRF Proof-of-Concept generator | Engagement Tools → CSRF PoC | [`csrf-poc.ts`](csrf-poc.ts) |
| Directory / file brute-force (gobuster-style) | Engagement Tools → Content Discovery | [`content-discovery.ts`](content-discovery.ts) |
| Authorization matrix (BOLA / IDOR / privesc) | Authorize / AuthMatrix extension | [`auth-matrix.ts`](auth-matrix.ts) |
| Notes + findings store with Markdown report | Engagement Tools → Notes | [`engagement-notes.ts`](engagement-notes.ts) |
| HTTP request smuggling probe | HTTP Request Smuggler extension | [`smuggler.ts`](smuggler.ts) |
| Tag-based chained encode/decode/transform | Hackvertor extension | [`hackvertor.ts`](hackvertor.ts) |
| **TUI dashboard** (Flows / Findings / Rules) | Burp's main window | [`dashboard.ts`](dashboard.ts) |
| **GUI workspace** (Solid + REST control API) | Burp's main window | `packages/app/src/pages/burp-workspace.tsx` |
| Shared lib (host gate, fingerprints, lib helpers) | — | [`_lib/common.ts`](_lib/common.ts) |

All tools are reachable from the AI agent via the **`burp_toolkit`** tool
(`packages/opencode/src/tool/burp_toolkit.ts`) — see "Agent integration"
below.

## Quickstart

### 1. Boot the proxy and trust the CA

```bash
# Run once to generate the local Root CA and start listening on 127.0.0.1:8181
bun packages/opencode/script/agent-tools/security/http-proxy.ts start --intercept

# In another shell: export and trust the CA
bun packages/opencode/script/agent-tools/security/http-proxy.ts ca-export ~/cc-ca.pem
# then add ~/cc-ca.pem to your OS / browser trust store
```

Configure your client (browser / curl / mobile app over Wi-Fi) to use
`http://127.0.0.1:8181` as HTTP proxy.

### 2. Drive the proxy from another shell

```bash
# Browse history
bun http-proxy.ts list --limit 20

# Inspect a flow
bun http-proxy.ts show 42

# Toggle intercept on/off
bun http-proxy.ts intercept on

# Persistent rewrite: replace any "foo" in response bodies with "bar"
bun http-proxy.ts match-and-replace add \
  --type response --scope body --match 'foo' --replace 'bar'

# Send a captured flow into the repeater
bun http-proxy.ts send-to-repeater 42 | bun http-repeater.ts send --json
```

### 3. Open the TUI dashboard

```bash
bun packages/opencode/script/agent-tools/security/dashboard.ts
```

Three panels (`Flows / Findings / Rules`); cycle with `Tab`, navigate with
`↑↓`, `enter` for detail, `i` to toggle interception, `/` to filter, `r`
to refresh findings, `s` to snapshot, `?` for help.

### 4. Or open the GUI workspace (Electron / web app)

Start the proxy with the REST control API:

```bash
bun packages/opencode/script/agent-tools/security/http-proxy.ts \
    start --intercept --api-port 8182
```

Then in the desktop app: **Toolkit Sicurezza → Burp Workspace**. You get
four live tabs:

- **Flussi**: full HTTP history with click-to-detail (request + response
  headers, bodies, security-relevant fields)
- **Intercept**: pending requests held by the proxy. Inoltra / droppa /
  edita method+headers+body before forwarding
- **Match&Replace**: regex rewrites stored in the same DB, toggle
  enabled/disabled per-rule live
- **Collabora con AI**: build a structured prompt that references the
  selected flow / pending intercept and copy it straight into the agent
  composer with `burp_toolkit` already wired.

The workspace re-renders via SSE (`GET /events`) and falls back to 3 s
polling if SSE is unavailable.

### 5. Drive intercepts from the CLI / agent

Even without the GUI you can resolve pending intercepts:

```bash
bun http-proxy.ts pending                          # list waiting
bun http-proxy.ts intercept-action 17 forward
bun http-proxy.ts intercept-action 17 drop
bun http-proxy.ts intercept-action 17 edit \
    --method POST --header 'Authorization: Bearer x' --body 'foo=bar'
```

## Per-tool quickref

### HTTP Intercept Proxy ([`http-proxy.ts`](http-proxy.ts))

- TCP-level MITM with per-host leaf certs signed by a local Root CA
- HTTPS supported via OpenSSL-issued leaves (cached on disk)
- Full request/response capture into a SQLite DB at
  `$XDG_DATA_HOME/crimecode/proxy/history.db`
- Intercept queue with `forward` / `drop` / `edit` actions
- Match-and-replace rewrites stored in the same DB (req/resp ×
  header/body/url, regex, enable/disable per-rule)
- Default exclude list for OS auto-update + telemetry endpoints
- Subcommands: `start | ca-export | list | show | send-to-repeater |
  intercept | match-and-replace | clear | stats`

### Repeater ([`http-repeater.ts`](http-repeater.ts))

- `send` / `replay` (with concurrency + status/latency distribution)
- `from-curl` (parse a `curl …` and execute it)
- `from-flow <id>` — replay a captured proxy flow with
  `--override-header`, `--override-method`, `--override-body`
- `from-har <path>` — replay every entry in a HAR file
- Auto-decompresses gzip/deflate/br responses
- Surfaces error fingerprints + security-headers grade

### Intruder / Fuzzer ([`http-fuzzer.ts`](http-fuzzer.ts))

- All four Burp attack types (sniper / battering / pitchfork /
  clusterbomb)
- `§…§` placeholders in URL / body / header values
- Built-in payload sets via `--builtin <name>`:
  `xss-basic`, `sqli-basic`, `path-traversal`, `ssrf`,
  `command-injection`, `open-redirect`, `log4shell`, `xxe`, `ssti`, `lfi`
- Composite ranking by status delta / length z-score / latency outliers
  / reflection / error fingerprints
- Rate-limited (10 req/s default), 1000-request hard cap

### Decoder / JWT ([`crypto-decoder.ts`](crypto-decoder.ts))

- `encode` / `decode` with chained formats
  (`--format=base64,base64,utf8`)
- `jwt-decode` — header + payload + flags (alg=none, expired, no-exp,
  long-lived, kid traversal)
- `jwt-tamper` — emit common attack variants (alg-none, alg-NONE,
  role/admin bumps, strip-exp, kid-traversal)
- `jwt-verify` — try HS256 secrets against the signature (built-in
  shortlist or `--wordlist FILE`)
- `smart` — format guesser with confidence scores
- `hash` — md5/sha1/sha256/sha384/sha512 or `--alg all`

### Comparer ([`http-comparer.ts`](http-comparer.ts))

- `diff` (line) / `words` / `bytes` / `json` / `headers`
- `from-flows A B` — pull two captured flows by ID and diff them
- Inputs from file (`--left PATH`), inline string (`--left-string S`),
  stdin (`--left=-`)

### Sequencer ([`token-sequencer.ts`](token-sequencer.ts))

- `collect` — fire N requests, extract a token each time (regex-driven
  capture from body / header / Set-Cookie)
- `analyse` — Shannon entropy (overall + per-position), static
  prefix/suffix, character-set width, FIPS-140-1 monobit/poker/runs/
  long-run with relaxed thresholds, per-position variety heatmap
- `live` — collect + rolling analyse with progress
- Verdict: `STRONG | ADEQUATE | WEAK | BROKEN`

### Vulnerability Scanner ([`vuln-scanner.ts`](vuln-scanner.ts))

Passive checks (`passive`, `batch`):

- Missing / weak security headers
- Cookie flag audit (Secure / HttpOnly / SameSite)
- Error fingerprints (SQL / stack / PHP / .NET / info-leak)
- Server / X-Powered-By banners
- Mixed content on HTTPS pages
- CORS misconfigs (wildcard with credentials, reflective origin)
- JWT misuse in body / Set-Cookie
- Secret patterns (AWS, Google, Slack, GitHub, Stripe, private keys)
- Open directory listing
- Authenticated-content cacheable

Active checks (`active`, must `--enable` per class):

- `xss-reflected`, `open-redirect`, `sqli-error`, `sqli-boolean`,
  `path-traversal`, `crlf`, `ssrf` (incl. AWS metadata),
  `command-injection`, `default-creds`

### Site Crawler ([`site-crawler.ts`](site-crawler.ts))

- HTML `href` / `src` / `action` extraction
- JS-literal sweep for `"/path"` strings
- robots.txt + sitemap.xml ingestion
- Form discovery with method + field names
- `--include-subdomains` / `--include` / `--exclude` glob filters
- `--max-depth`, `--max-pages` (hard cap 5000)
- Markdown tree / `--json` / `--csv` output

### Param Miner ([`param-miner.ts`](param-miner.ts))

- Modes: `query`, `header`, `cookie`, `body`
- Built-in wordlists (~250–300 names per mode) or `--wordlist FILE`
- Detects status / length / header-set / body-hash deltas
- Reflection check on a unique guard string

## Agent integration — `burp_toolkit` tool

Registered in `packages/opencode/src/tool/registry.ts`. The agent calls
it like any other tool:

```json
{
  "subtool": "scanner",
  "args": ["passive", "--url", "https://example.com", "--json"],
  "as_json": true
}
```

`subtool` is one of:
`proxy | repeater | intruder | decoder | comparer | sequencer | scanner | crawler | param-miner |
collaborator | csrf-poc | content-discovery | auth-matrix | engagement-notes | smuggler | hackvertor`.

The wrapper:
- Resolves the script path relative to the repo root
- Spawns it with `bun`
- Pipes optional `stdin`
- Appends `--json` when `as_json: true`
- Asks the user for permission once per session for active sub-tools
  (`intruder`, `scanner` active mode, `sequencer`, `param-miner`,
  `crawler`)
- Hard timeout default 120 s (override with `timeout_ms`)

## Storage

```
$XDG_DATA_HOME/crimecode/proxy/
├── ca/
│   ├── ca.pem            ← Root CA (export & trust)
│   ├── ca-key.pem        ← private key, mode 0600
│   └── leaf-*.pem        ← per-host leaves, generated lazily
├── history.db            ← SQLite: flows, rules, settings
└── …
```

On Windows the default is `%LOCALAPPDATA%\crimecode\proxy\` (Bun
respects `XDG_DATA_HOME` if set, otherwise falls back to
`~/.local/share/crimecode/proxy`).

## Safety rules

- Every active tool refuses private/loopback targets unless
  `--allow-private` is passed (catches accidental localhost / RFC1918
  hits from the agent).
- Active scanner requires `--enable=class1,class2,…`. There is no
  "scan everything" switch — pick what you need.
- Intruder is rate-limited to 10 req/s by default and capped at 1000
  total requests per invocation.
- The proxy listens on `127.0.0.1` by default. Use `--bind 0.0.0.0`
  only on isolated lab networks.
- Default no-MITM list excludes OS auto-update + telemetry +
  certificate-OCSP endpoints so you don't break the rest of the system.

## Style rules for new tools (avoiding TDZ traps)

These scripts run with **top-level `await`** under Bun. The dispatch
block (`if (cmd === "x") cmdX()`) executes during the *first synchronous
phase*, which means it must **not reference any `const` or `let`
declared further down the file**. Doing so produces a confusing
`ReferenceError: Cannot access 'X' before initialization` at runtime —
it's the exact bug that broke `proxy ca-export`, `dashboard --help`,
and `fuzzer --builtin` in earlier revisions.

**Rule of thumb — declare in this order, top to bottom:**

```ts
// 1. Imports
import { … } from "node:…"
import { … } from "./_lib/common.ts"

// 2. Path / lazy-state constants
const HERE     = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = …
const DB_PATH  = join(DATA_DIR, "…")

// 3. Runtime data tables, wordlists, severity ranks
const BUILTIN_PAYLOADS = { … }
const ACTIVE_CHECKS    = [ … ] as const
const SEV_RANK         = { info: 0, low: 1, … }

// 4. Module-scoped runtime state holders that handlers mutate
let CA: Ca | null = null
const CTX_CACHE = new Map<…>()

// 5. CLI parser + dispatch
const cli = makeArgs(argv)
const cmd = cli.args[0]
if (!cmd || cli.has("--help")) usage(0)
if (cmd === "start") await cmdStart()
else if (cmd === "list") cmdList()
…

// 6. Functions, interfaces, types — order doesn't matter here
//    (function declarations are hoisted; interface/type are erased)
function cmdStart() { … }
interface Ca { … }
function usage(code: number): never { … }
```

The audit script enforces this:

```bash
bun packages/opencode/script/agent-tools/security/_lib/audit.ts
```

It prints any `const`/`let` referenced at the top level **before** its
own declaration line in any toolkit file. Exit code:
- `0` clean (good for CI gating)
- `1` one or more violations
- `2` audit script error

`interface`, `type`, and `function` declarations are intentionally
allowed below — they're either erased at compile time (types) or hoisted
at runtime (function declarations). The audit also skips references
that live inside function bodies, since those only run when the function
is called (which is presumably *after* the const has been declared).

If you must reference data declared lower down, wrap it in a function
(those are hoisted). Concretely:

```ts
// ❌ Won't work — TDZ on PAYLOADS
if (cmd === "x") console.log(PAYLOADS)
const PAYLOADS = { … }

// ✅ Works — getPayloads() is hoisted, body runs lazily
if (cmd === "x") console.log(getPayloads())
function getPayloads() {
  return { … }
}
```

## Linking with the existing red-team helpers

- [`redteam-replay.ts`](../redteam-replay.ts) — engagement-file-driven
  payload corpus replay against an authorised target. The proxy's
  history DB is a perfect source of payloads (extract via
  `http-proxy.ts list --json`, transform, feed into redteam-replay).
- [`secret-scan.ts`](../secret-scan.ts) — scan filesystem for secrets;
  pair with `vuln-scanner.ts batch` (which scans network responses).
- [`fetch-url.ts`](../fetch-url.ts) — for benign read-only fetches; the
  Burp toolkit is for security work specifically.

## TODO / future work

- WebSocket interception (currently the proxy passes WS upgrades through
  unmodified)
- HTTP/2 + HTTP/3 MITM
- Burp Collaborator-style OOB capture server (dns + http callback
  domain)
- BApp-store-style plugin loader
- Browser extension to drive the proxy from the page context
