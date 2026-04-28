---
name: code-review-as-author
description: Use before opening a PR. Self-review the diff like a stranger would, scope-check, run pre-flight tools (secret-scan, api-shape, dep-audit), draft the description so reviewers can approve in one pass instead of three.
---

# Code Review as Author

## When to Use

- You're about to open a PR.
- You finished an implementation and want to clean up before review.
- A previous review round bounced back with cosmetic / scope nits and
  you want to avoid round 2.

**Don't use** for draft PRs or RFC discussions where the diff IS the
artefact. This is for "ready for review".

## The Premise

A code review is a conversation. Every nit your reviewer types is a
round-trip you could have prevented. Authors who self-review save
hours of cumulative team time per PR. Tools below automate the obvious
checks so the reviewer can focus on judgment calls, not typos.

## The Pre-flight Checklist

| # | Check | Tool | Pass criteria |
|---|-------|------|---------------|
| 1 | No secrets staged | `secret-scan.ts` | exit 0 |
| 2 | Typecheck clean | `bun run typecheck` | 0 errors |
| 3 | Targeted tests pass | `run-tests-for.ts --staged` | green |
| 4 | API surface diff reviewed | `api-shape-extract.ts --diff` | every change intentional |
| 5 | No new vulnerabilities | `dep-audit.ts --severity=high` | exit 0 |
| 6 | Diff summary under control | `diff-summary.ts` | files in scope, no junk |
| 7 | Semver bump suggestion matches your intent | `semver-bump-suggest.ts` | recommendation aligns |

If any fail, fix BEFORE opening the PR. Reviewers shouldn't be the
linter.

## The Walk-through

### 1. Re-read your diff out loud

```bash
git diff --stat origin/master..HEAD     # what
git diff origin/master..HEAD | less     # how
```

For each hunk, ask:

- **Does this belong in this PR?** Drive-by changes lengthen review
  and confuse the diff. Move them to a separate PR or revert them.
- **Is this the smallest change that solves the problem?** Bigger
  isn't safer. Bigger is harder to review.
- **Would I understand this in 6 months?** If not, comment.

If your eyes glaze over reading your own code, the reviewer's will too.
Tighten before submitting.

### 2. Run the tools

```bash
# All-in-one pre-flight (replace with your repo's path):
bun packages/opencode/script/agent-tools/secret-scan.ts \
  && bun run typecheck \
  && bun packages/opencode/script/agent-tools/run-tests-for.ts --staged \
  && bun packages/opencode/script/agent-tools/diff-summary.ts \
  && bun packages/opencode/script/agent-tools/dep-audit.ts --severity=high
```

If you're touching public exports:

```bash
# Snapshot pre-PR (run on master before you start):
bun packages/opencode/script/agent-tools/api-shape-extract.ts > /tmp/api-master.txt
# Compare your branch:
bun packages/opencode/script/agent-tools/api-shape-extract.ts --diff /tmp/api-master.txt
```

Every removal / signature change in the diff is a potential breaking
change for consumers — call it out in the PR description and bump the
semver appropriately.

### 3. Draft the PR description

Format that pre-empts 80% of reviewer questions:

```md
## Summary

One sentence: what this PR does, in user-visible terms.

## Why

Two-three sentences: the problem this solves. Link to issue / incident /
benchmark / metric. Reviewers shouldn't have to dig.

## Approach

Bullet list: the design choices made, with rationale. Especially call
out the alternatives you rejected and why ("why not just X?").

## Testing

- [ ] New regression test: `path/to/test.ts::test name`
- [ ] Manual repro: ...
- [ ] Tested at: <staging URL / commit hash>

## Risks

- What can go wrong if this is buggy?
- What does the rollback look like?
- Any feature flag / kill switch?

## Out of scope

What the reviewer might ask "why didn't you also do X?" — pre-empt it.
```

If the PR has fewer than 50 lines of code, "Summary" + "Testing" is
enough. Cargo-culting a long description on a tiny PR is wasteful.

### 4. Commit hygiene

- **Each commit compiles + passes tests.** Bisect is your friend later.
- **Each commit is self-contained.** `feat: rename X` → `feat: rename X
  + fix one call site` should be one commit, not two.
- **Squash WIP / fixup commits.** `wip` / `fix typo` / `address review`
  noise blocks bisect.

```bash
git rebase -i origin/master   # squash WIP, reorder
```

(Don't rebase merged branches; this is for your own pre-merge
hygiene.)

### 5. CI signal

If your repo has CI:

- Run it on your fork/branch before opening the PR.
- Fix red builds before requesting review. Reviewers shouldn't be the
  build farm either.

## Anti-patterns

| Don't | Why |
|-------|-----|
| Open a PR with WIP commits | Reviewers can't bisect; merge becomes one big rollup. |
| Mix refactor + feature | Reviewer can't tell which line is the feature. |
| Bury the breaking change in commit #4 | Should be commit #1 + flagged in description. |
| Open a 2,000-line PR for a single feature | Split it. Reviewers will rubber-stamp. |
| Hand-wave "I tested it" with no specifics | Say which test, which command, what result. |
| Ignore your own typecheck/lint warnings | Reviewer has to comment on each one. Fix them. |
| Push and immediately request review | Self-review for 10 minutes first. You'll catch 3 issues. |
| "Address feedback" commits left unsquashed | Final history should look like a polished story, not a chat log. |

## Reviewer-friendly diffs

Some patterns make a reviewer's job 10× easier:

- **One concept per commit.** Easy to read in sequence.
- **Rename + use in same commit.** Reviewer doesn't have to mentally
  trace "wait, was X already named Y?".
- **Small, semantic file moves.** `git log --follow` should still
  work; if you move + edit a file in one commit, edit-only follow-ups
  break.
- **Tests near the change.** Don't bury a test for the new code in a
  separate commit at the end.

## Worked example — checklist run

```bash
# 1. Pre-flight tools
$ bun script/agent-tools/secret-scan.ts
✅ Clean — scanned 12 file(s), no secrets detected.

$ bun run typecheck
Tasks: 13 successful, 13 total

$ bun script/agent-tools/run-tests-for.ts --staged
…
PASS  src/license/auth.test.ts (12 tests, 12 pass)

$ bun script/agent-tools/diff-summary.ts
# Branch summary — 3 commits, 5 files, +120 / -10
…

$ bun script/agent-tools/api-shape-extract.ts --diff /tmp/api-master.txt
# API diff — 2 added, 0 removed, 0 changed
+ function consumePendingReferralBonus
+ function applyReferralBonusToTrial
✅ No removed exports — additive only.

$ bun script/agent-tools/dep-audit.ts --severity=high
✅ No vulnerabilities found.

$ bun script/agent-tools/semver-bump-suggest.ts
# semver bump — base origin/master  →  🟡 MINOR
Signals:
  🟡 [api-shape] (minor) 2 new export(s) → backwards-compatible additions

# 2. Draft PR description (the format above).
# 3. `gh pr create` — reviewer gets a clean diff, structured description,
#    confidence that pre-flight is green. Fewer round trips.
```

## Related skills

- **pre-commit-review** — finer-grained per-commit version of this.
- **dependency-update-safety** — when this PR is a dep upgrade.
- **plan-before-execute** — for PRs > ~300 LoC, plan first.
