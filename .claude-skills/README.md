# Agent skills + tools for CrimeCode IDE

This directory holds **skills** — markdown files that encode process
discipline an AI coding agent should apply during real work. Companion
**helper scripts** live at `packages/opencode/script/agent-tools/`.

Both surfaces ship together because they answer the same question:
*how do we make the in-IDE agent meaningfully better at real work,
without re-prompting it from scratch every session?*

## How the agent picks these up

The CrimeCode IDE / OpenCode agent runtime auto-discovers skills under
`.claude-skills/` at session start. Each `.md` file with a YAML
frontmatter `name:` + `description:` becomes invokable. The agent
decides which to use based on the description's `Use when …` clause.

The runtime also exposes the `script/agent-tools/*.ts` files via the
Bash tool — no special wiring needed beyond knowing the path. The
skill docs reference the tool helpers explicitly so the agent knows
where to call them from.

## Skills (in `.claude-skills/`)

| Skill | When the agent invokes it |
|---|---|
| **pre-commit-review** | Before every git commit. Checklist: typecheck, lint, tests, secrets scan, debug leftovers. |
| **schema-migration** | Any change to a DB schema, JSON column shape, public API. Forces migration-first thinking. |
| **security-review-on-diff** | When a diff touches auth, payments, queries, file ops, crypto. Catches SQLi, hardcoded secrets, missing rate limit, etc. |
| **onboarding-overview** | First arrival in a new repo. Replaces 30 ad-hoc tool calls with one structured brief. |
| **verification-before-completion** | Before saying "done". Self-verifies via typecheck + targeted tests + E2E probe. |
| **plan-before-execute** | Multi-file / public-API / refactor tasks. Submit plan, get approval, then execute. |
| **multi-agent-dispatch** | Tasks that decompose into specialist concerns. Fan out subagents in parallel, merge their reports. |
| **context-pruning** | Long sessions. Compress stale Reads, drop dead tool output, periodic state checkpoints. |
| **resume-after-crash** | Re-entry after an interruption. Reconstructs working state from git status + uncommitted diff + TodoWrite. |
| **redteam-replay** | Authorised security replay. Mandatory consent + scope + audit guardrails. |
| **web-research** | Look up current docs / CVEs / "is this a known issue" via live web search. Pairs with `web-search` + `fetch-url` + `docs-extract`. |
| **stack-trace-triage** | User pastes a stack trace. Resolve frames to source, show ±2 line excerpts, propose minimal fix. |
| **dependency-update-safety** | Bumping a dep version. Baseline → changelog → upgrade → targeted tests → flake detection → re-audit → PR. |

## Tool helpers (in `packages/opencode/script/agent-tools/`)

All scripts are `bun`-runnable, single-file, no external deps beyond
git + ripgrep where noted.

| Script | What it does |
|---|---|
| **token-budget-estimate.ts** | Estimates remaining context window from transcript on stdin / file. Output: utilisation %, advice (prune now / safe). |
| **project-map.ts** | One-pass structural overview of any repo: type, languages, build commands, env vars, migrations, hot files, TODO count. Markdown or JSON. |
| **run-tests-for.ts** | Runs ONLY tests that import the changed file(s). Replaces "let me run the full suite" with "the 3 tests that matter". |
| **apply-patch-atomic.ts** | Apply a unified diff in transaction: dry-run first, snapshot, apply, optional typecheck, rollback on any failure. |
| **runtime-tail.ts** | Filtered tail of the OpenCode runtime log. Service / grep / since / follow. |
| **find-symbol.ts** | LSP-lite `def` / `refs` / `both` over the TS codebase. Word-boundary, definition-pattern aware. |
| **diff-summary.ts** | Single-page summary of branch state vs base: files, +/-, new/deleted, untracked, anti-pattern grep (secrets, console.log, TODOs). |
| **redteam-replay.ts** | Authorised payload replay runner. **READ THE redteam-replay.md SKILL FIRST.** Engagement file required, sandboxed by default. |
| **web-search.ts** | Live web search. Backends: Brave Search API (preferred, set `BRAVE_SEARCH_API_KEY`), SearXNG (`SEARXNG_URL`), DuckDuckGo HTML fallback. `--site=`, `--limit`, `--json`. |
| **fetch-url.ts** | Fetch a URL and emit a clean markdown excerpt — drops scripts/nav/footer, isolates `<article>` / `<main>`, transforms HTML → MD. Caps at 32 KB by default to protect context. |
| **dep-audit.ts** | CVE audit via OSV.dev. Auto-detects npm/Cargo/Go/Python manifests + lockfiles; severity filter; JSON output for chaining. |
| **stack-trace-resolve.ts** | Parse stack traces (Node/Bun, Deno, Python, Go, Rust, Java) and emit per-frame source excerpts with `>>>` markers on the offending line. |
| **flaky-test-detect.ts** | Run a test command N× and flag tests that pass-and-fail across runs. Auto-detects Bun/Vitest/Jest/cargo/pytest/go-test. |
| **docs-extract.ts** | Pull homepage + repository URLs for every dependency in the project (npm via registry, others derivable). Chains into web-search / fetch-url. |

## Calling the tools from a skill

Skills reference their tools by relative path. Example from
`pre-commit-review.md`:

```bash
bun packages/opencode/script/agent-tools/run-tests-for.ts <changed-files…>
```

Skills can compose. `pre-commit-review` runs `run-tests-for` AND
`diff-summary --secrets-only`. `verification-before-completion` runs
`run-tests-for` + a curl probe.

## Adding a new skill

1. Pick a name (kebab-case, matches the filename).
2. Copy any existing skill as a template — keep the YAML frontmatter
   shape, the **When to Use / Don't skip when** structure, **The
   Process / The Checklist**, **Red Flags**, **Output Format**,
   **Related skills**.
3. If the skill needs a tool helper, write it in
   `packages/opencode/script/agent-tools/`.
4. Reference both from this README so future agents discover them.

## Adding a new tool helper

1. Single file in `packages/opencode/script/agent-tools/<name>.ts`.
2. Top of file: a docstring explaining usage + flags + output shape.
3. Keep external deps minimal — bun + git + ripgrep is the floor;
   anything else should be justified.
4. Exit code matters: 0 = clean, non-zero = failure (so skills can
   chain).
5. Document it in the table above.

## Why this directory exists

The OpenCode / CrimeCode IDE agent is a generalist by default. Without
process discipline, every session re-discovers the same failures
(skipped typecheck, missing migration, security regression). These
skills encode the discipline once. Tool helpers turn the discipline
into single commands that take seconds, not minutes.

The result: less hand-holding from the user, fewer "agent said done
but it didn't work" moments, fewer rollbacks.
