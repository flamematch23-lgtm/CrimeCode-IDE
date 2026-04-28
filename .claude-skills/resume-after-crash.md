---
name: resume-after-crash
description: Use when re-entering a session that was interrupted (network drop, IDE crash, tab close, intentional pause). Reconstructs the working state from on-disk artifacts so work doesn't restart from zero.
---

# Resume After Crash

## Overview

Long sessions get interrupted. The agent's process dies, the user
closes the laptop, the network drops mid-tool-call. The default for
most agent runtimes is "start fresh", which means the user manually
explains what was already done.

This skill reconstructs the in-progress state from artifacts that
**survived** the interruption: files on disk, git status, TodoWrite
persistence, terminal history.

## When to Use

Trigger any of:

- The user says "resume" / "pick up where we left off" / "continua"
- The user references work from a previous session ("the plan we made
  yesterday")
- The agent boot context shows recent uncommitted changes the agent
  doesn't remember making
- A `.agent-state.json` (or equivalent) exists in the repo root
- TodoWrite has unfinished items from a previous session

**Don't trigger**:
- For brand-new tasks (use `onboarding-overview` instead)
- When the user explicitly says "start over"

## The Process

### 1. Check the working tree

```bash
git status --short
git diff --stat
git log --oneline -5
git stash list
```

Uncommitted changes are the strongest signal: the previous session was
mid-task. Commit history shows what landed, stash list shows what was
parked.

### 2. Reconstruct the original goal

If the user has a fresh request, **anchor on it** — the previous work
might be irrelevant.

If the user says "resume", look for:
- `.agent-state.json` (if the project supports it) — has the active
  plan, completed steps, open todos.
- Recent commit messages that look mid-flight (e.g., "WIP", "checkpoint",
  "save progress").
- TODOs in source files near the uncommitted diff.

### 3. State what you found, ask before continuing

Don't silently dive in. The user might have changed direction since.

```
Resume detected:

  Uncommitted changes:
    M packages/opencode/src/license/auth.ts (+47 -12)
    M packages/opencode/src/license/telegram.ts (+89 -3)
    ?? .claude-skills/                     (new directory, 7 files)

  Last commit: "feat(bot): inline buttons …" (2 hours ago)

  Reading the uncommitted diff suggests the previous session was
  mid-way through "add /referral command + claim flow". The bot
  command exists but the renderer-side referral page was not added.

  Do you want to:
    1) Continue with the renderer page
    2) Commit the current state and start something else
    3) Discard the uncommitted work
```

### 4. Verify the state is consistent

Before continuing, run a sanity pass:

```bash
bun run typecheck
git diff packages/opencode/src/license/auth.ts | grep -E '^[+-]' | head -50
```

Two failure modes to catch:

- The uncommitted diff is half-typed — symbols referenced but not
  defined yet. The previous session was interrupted mid-Edit. You'll
  see typecheck errors that line up with the diff.
- The diff conflicts with new commits on master/origin. Run
  `git fetch origin master && git diff master..` to see what landed
  while you were away.

### 5. Continue with explicit context

When you DO continue, frame it:

```
Resuming "add /referral command + claim flow":
  ✓ Schema (referral_codes + referral_claims tables) — committed
  ✓ Backend helpers + endpoint — uncommitted, typechecks
  ✓ Bot /referral command — uncommitted, typechecks
  ⏳ Renderer dashboard panel — not started

Working on the renderer panel now.
```

## Persistence helpers

Where to save/restore state for next time:

### TodoWrite persistence

The TodoWrite list is the strongest "what was I doing" signal. The
runtime auto-persists it for the active session. To survive a process
restart:

```bash
# After every TodoWrite update, the runtime should write to:
~/.local/share/opencode/sessions/<session-id>/todos.json
```

If a session id was passed to the new run, the list re-hydrates.

### Manual checkpoint files

For longer-form context (current plan, design decisions made), write
a tracked file:

```
.agent-checkpoint.md   (gitignored)
```

```markdown
# Active plan: license auto-apply on login

## Status: 80% — last updated 2026-04-28T14:32

## Done
- Server endpoint /account/me/license
- Renderer cloud-sync.applyCloudLicenseIfDesktop wired to 4 success paths

## In flight
- Bot /mylicense command — half-written, see uncommitted diff in
  packages/opencode/src/license/telegram.ts

## Blockers
- None

## Next
- Test the bot command end-to-end
- Bump version to 2.22.20
```

The file is checked in `.gitignore` — it's an agent-private journal,
not a code artifact.

### Terminal output recovery

If the previous session's stdout was captured (e.g., in `dev.log`),
grep for the last successful tool call to know how far things got:

```bash
tail -100 ~/.local/share/opencode/log/dev.log | grep -E "completed|error"
```

## Red Flags

| Thought | Reality |
|---|---|
| "I'll just start fresh, the diff isn't important" | The diff is the only proof of where you were. Read it. |
| "The user knows what they want, I'll skip the resume check" | The user often ALSO doesn't remember exactly. Show what you found. |
| "Uncommitted = bad, let me reset" | NEVER. That's destruction without consent. |
| "I'll merge the resumed work with new work silently" | Don't. State the merge clearly so the user can intervene. |

## Anti-pattern: secretly continuing

If you detect resume state but don't tell the user, you risk doing
work that contradicts what the user actually wants now. Always
surface the resumed state before acting on it.

## Related skills

- `onboarding-overview` — for *new* repos, not resumed sessions
- `plan-before-execute` — if the resumed plan is still valid, skip
  re-planning; if it's stale, plan fresh
- `verification-before-completion` — important after a resume because
  state may have drifted
