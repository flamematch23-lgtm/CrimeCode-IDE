---
name: pre-commit-review
description: Use BEFORE every git commit; runs a non-skippable checklist (typecheck, lint, tests, secrets, debug-leftovers) on changed files. The most common shipped bug is a thing a linter would have caught.
---

# Pre-commit Review

## Overview

Before any commit lands, run this checklist on the **diff**, not the
whole repo. Two minutes spent here saves a rollback later.

**The Iron Rule**: if the checklist fails, **do not commit** — fix the
issue or back out the change. Never `git commit --no-verify`. If a hook
is wrong, fix the hook.

## When to Use

Trigger any time you're about to call `git commit`. Also trigger when
the user types "commit", "ship", "ok push", or any imperative that
implies finalising work.

**Don't skip when**:
- You're in a hurry — that's exactly when bugs land.
- The change is "trivial" — trivial bugs ship the most.
- The hook is annoying — fix the hook, not the discipline.

## The Checklist

Run **all** in sequence on the changed files. Stop on first failure.

### 1. Typecheck the touched packages

```bash
# Find which packages have changes
git diff --name-only HEAD | xargs -n1 dirname | sort -u
# Run typecheck for each (turbo handles the dep graph)
bun run typecheck
```

If errors: report them in plain language (no full stack traces).
"3 type errors in `packages/opencode/src/license/teams.ts`: …".

### 2. Lint the diff (not the whole repo)

```bash
git diff --name-only HEAD --diff-filter=ACM | grep -E '\.(ts|tsx|js|jsx)$' | xargs -r bunx biome check
```

### 3. Run tests that exercise the changed files

Use the `run-tests-for` agent tool:

```bash
bun packages/opencode/script/agent-tools/run-tests-for.ts <changed-files...>
```

If no tests exist for a changed file → flag it. Don't auto-add fluff,
but ask the user "want a test for this?".

### 4. Secrets / credentials scan

Grep the diff for common leak patterns:

```regex
(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}
sk-[A-Za-z0-9]{20,}        # OpenAI
ghp_[A-Za-z0-9]{30,}        # GitHub PAT
TELEGRAM_BOT_TOKEN.*[:=]\s*["'][0-9]{8,}:[A-Za-z0-9_-]{30,}
-----BEGIN (RSA |OPENSSH )?PRIVATE KEY-----
```

If a hit: **STOP**. Don't commit. Move secret to env / `.env.local`,
add to `.gitignore`, history-rewrite if the secret is real.

### 5. Debug leftovers

Grep the diff for:
```
console\.log\(           # forgotten log
debugger\b               # forgotten breakpoint
\.only\(                 # focused test that would skip the rest
TODO[: ]                 # unresolved TODO authored in this diff
fdescribe\b|fit\b        # focused jest specs
xit\b|xdescribe\b        # disabled tests
```

A `console.log` in a system module isn't a hard fail (might be
intentional logging) — flag for confirmation. `.only()` and `fit/xit`
are always blockers.

### 6. Commit message sanity

The message should say **why**, not just what. "fix bug" is a fail.
"fix(auth): drop expired sessions on touch — race vs revocation" is a
pass. If the message is weak, rewrite it.

## Red Flags

If you find yourself thinking:

- "It's just a small fix, skip the typecheck" → no
- "The tests are slow, run them later" → no, that's how regressions land
- "I'll add the test in the next commit" → write it now or open a tracked
  TODO with a deadline
- "The lint is wrong" → fix the lint config in a separate commit, not
  with `--no-verify`

## Output Format

After running the checklist, produce a single block:

```
✅ Pre-commit review — packages/opencode/src/license/teams.ts (+47 -12)

  • typecheck         ✓
  • lint diff         ✓
  • tests touched     ✓ (3 tests, all passing)
  • secrets scan      ✓ (no hits)
  • debug leftovers   ⚠ 1 console.log at line 247 — keep? (intentional log)
  • commit message    ✓

Ready to commit. Confirm the console.log first.
```

Or, on failure:

```
❌ Pre-commit review failed — do NOT commit yet

  • typecheck         ✗ 2 errors
    - teams.ts:147 — Property 'token' does not exist on type 'CustomerRow'
    - teams.ts:189 — Cannot find name 'logSomething'
  • lint diff         (skipped — fix typecheck first)

Fix the type errors above, then re-run the review.
```

## Related skills

- `verification-before-completion` — run AFTER pre-commit-review, before
  declaring a task done.
- `security-review-on-diff` — heavier security pass for security-
  sensitive code (auth, payments, crypto).
