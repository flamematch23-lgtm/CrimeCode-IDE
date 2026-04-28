---
name: context-pruning
description: Use throughout long sessions. Actively trim stale context so the attention window stays focused on the active task. Quality degrades from clutter long before token exhaustion — pruning preempts that.
---

# Context Pruning

## Overview

A 200k context window doesn't mean you can fill it with noise. Past a
threshold (~30% utilisation in practice), attention starts dispersing
across irrelevant blocks. The model spends compute looking at stale
file content, dead-end tool output, old plans that have been
superseded.

Active pruning keeps the relevant signal dense.

## When to Use

Trigger when any of:

- Context utilisation > 30% (estimate via `token_budget_check` tool)
- Tool output included a long file or large directory listing
- A previous plan / approach was abandoned mid-task
- The user changed direction after several round-trips
- You're about to read a file you've already read this session

**Don't prune**:
- The user's original request — that's the north star, never lose it.
- The active plan / TodoWrite list — that's the current contract.
- Successful E2E verification output — proof matters.

## The Process

### 1. Identify what's safe to discard

Three categories of discardable context:

**Stale file reads**:
- Files Read in tool call N, edited in N+5 — the read content is now
  wrong (Edit tool already mutated it). Reference the file by path,
  not by quoting the old content.

**Dead-end tool output**:
- A `find` / `grep` that returned nothing useful.
- A `gh run view` that was checking for a build that's now
  superseded by a newer run.
- A failed approach you already abandoned.

**Resolved exploration**:
- After answering "where does X live?", you don't need to keep the
  exploration trail — keep the answer ("X lives in Y.ts:42").

### 2. Compress, don't delete

Instead of "I read packages/opencode/src/server/server.ts (700 lines)
and saw the full content", compress to:

> server.ts (700 lines): Hono app with auth middleware (line 146,
> handles Basic + Bearer), routes mounted at /global, /security,
> /license, /sync, /account, /session, /project. Bus event listener
> at line 543. Skipped reading line-by-line — re-read on demand if
> a specific section is needed.

The compression removes ~600 tokens of file body but preserves
"where to look if I need to come back".

### 3. Drop the long tool outputs entirely

If a `gh run view --log-failed` returned 5kb of stack trace and you've
already extracted the one error line that mattered, drop the rest:

> Build log line 847: `error: Failed to extract executable for
> 'bun-windows-x64-baseline-v1.3.13'`. Resolved by removing the broken
> workflow file.

### 4. Maintain a "live state" reference at session-mid checkpoint

Roughly every 30 turns of a long session, the agent should state:

```
=== State checkpoint ===

Active task: <one sentence>
Done: <key milestones reached>
Current step: <what TodoWrite says is in_progress>
Open question: <what's blocking, if anything>
```

This compressed state lets the agent retain situational awareness
even as raw context cycles out.

## Practical compression examples

**Before** (450 tokens):
> Read packages/opencode/src/license/teams.ts. The file is 396 lines.
> It exports: createTeam(owner, name) at line 71, renameTeam at line
> 87, deleteTeam at 97, getTeam at 107, getMemberRole at 111,
> listTeamsForCustomer at 120, getTeamDetail at 136, addMemberByIdentifier
> at 180, removeMember at 225, ... [lengthy continued list]
> [paste of the entire file content]

**After** (40 tokens):
> teams.ts (396 lines): team CRUD + member mgmt. Key exports:
> getMemberRole(teamId, cid), listTeamsForCustomer(cid), addMemberByIdentifier.
> Re-read for specifics on demand.

### When NOT to compress

- The user is about to ask a question that requires the full content
  → keep it
- You're going to Edit the file in the next 1-2 turns → keep it (Edit
  needs a recent Read)
- The content contains the bug under investigation → keep it
- Source-of-truth blocks like the user's request, the active plan,
  the failing test output → keep them verbatim

## Red Flags

| Thought | Reality |
|---|---|
| "I'll keep everything, more is better" | NO. Past 30% utilisation, attention disperses. |
| "Compressing might lose detail I need" | If you need it, re-read it. Disk is cheap. |
| "I just dumped a 200kb log into context" | Extract the line that matters, drop the rest in the same turn. |
| "The Read output is part of my proof" | Quote one line. The full body is not proof. |

## Tooling

Use `token_budget_check` (agent tool, see scripts/agent-tools/) to
get an estimate of remaining tokens. Run this at:
- Session start
- Mid-session if you've done >30 tool calls
- Before making a plan that will require many more reads

## Related skills

- `plan-before-execute` — pruning + fresh plan after a 50-turn session
  is healthier than pushing through with stale state
- `multi-agent-dispatch` — sub-agents are inherently context-isolated;
  fanning out is a heavy form of pruning
