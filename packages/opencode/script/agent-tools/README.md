# Agent tool helpers

Single-file `bun` scripts that the CrimeCode / OpenCode agent uses to
do real work in seconds instead of orchestrating dozens of inline tool
calls.

See the **`.claude-skills/`** directory at the repo root for the
process-side companions (skills define *when* to invoke a helper; the
helpers below define *how*).

## Quick reference

```bash
# How much context do I have left?
bun packages/opencode/script/agent-tools/token-budget-estimate.ts < transcript.txt

# What does this repo look like?
bun packages/opencode/script/agent-tools/project-map.ts

# Test only what I changed
bun packages/opencode/script/agent-tools/run-tests-for.ts --staged

# Apply a diff atomically (dry-run, snapshot, apply, typecheck, rollback on fail)
bun packages/opencode/script/agent-tools/apply-patch-atomic.ts --typecheck < my.diff

# Tail the running sidecar's log, filtered
bun packages/opencode/script/agent-tools/runtime-tail.ts --service team-reaper --follow

# Where is `revokeSession` defined / used?
bun packages/opencode/script/agent-tools/find-symbol.ts both revokeSession

# What's in this branch vs origin/master?
bun packages/opencode/script/agent-tools/diff-summary.ts

# Authorised security replay (READ THE SKILL FIRST)
bun packages/opencode/script/agent-tools/redteam-replay.ts \
  --engagement .redteam-engagements/internal-2026-04.json \
  --target staging-api \
  --corpus payloads/xss.jsonl \
  --confirm "I have explicit authorisation to test internal-2026-04"

# Live web search (Brave Search API, SearXNG, or DDG fallback)
bun packages/opencode/script/agent-tools/web-search.ts \
  --site=github.com '"useMenuItemContext" kobalte'

# Read a URL as clean markdown (chains after web-search)
bun packages/opencode/script/agent-tools/fetch-url.ts \
  https://docs.solidjs.com/reference/components/show \
  --max-bytes=16000

# CVE audit on the project's deps via OSV.dev
bun packages/opencode/script/agent-tools/dep-audit.ts --severity=high

# Parse a stack trace + show source context for each frame
echo "$trace" | bun packages/opencode/script/agent-tools/stack-trace-resolve.ts

# Run a test command 5× and detect flakes
bun packages/opencode/script/agent-tools/flaky-test-detect.ts -n 5

# Pull homepage / repo URLs for every dep (chains into web-search / fetch-url)
bun packages/opencode/script/agent-tools/docs-extract.ts --filter solid
```

## Conventions

- **stdin or path**: every script that takes input accepts both stdin
  and a positional file argument. Pipe-friendly by design.
- **--json output mode**: helpers that produce structured data offer
  `--json` for downstream tooling, default to markdown for humans.
- **Exit codes**: 0 = success, 1 = soft failure (no matches, dirty
  diff), 2 = misuse (bad args). Skills chain on exit code.
- **No global side effects**: nothing writes outside its expected
  output unless the script is explicitly destructive (e.g.,
  `apply-patch-atomic.ts` writes to the working tree, but only via
  `git apply` and only after a snapshot).

## Adding a new helper

1. Single `.ts` file. No build step.
2. Top-of-file docstring: usage, flags, output shape, limitations.
3. `bun` shebang.
4. Document in `.claude-skills/README.md` table + this file.
5. If the helper has a corresponding skill, cross-link them so the
   agent finds either entry point.
