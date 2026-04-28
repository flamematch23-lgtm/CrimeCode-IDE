---
name: plan-before-execute
description: Use for any task that touches >2 files, introduces a new abstraction, or modifies a public API. Submit a plan as a structured proposal first; wait for user approval; only then execute. Cuts rollback rate massively.
---

# Plan Before Execute

## Overview

When a task is non-trivial, the highest-value thing the agent can do
is **align on the plan before writing code**. A misunderstood goal +
2 hours of execution = the agent has to rewrite or revert. A 30-second
plan exchange almost always avoids that.

## When to Use

Trigger plan-mode for any of:

- The change touches >2 files.
- The change introduces a new file the user didn't ask for by name.
- The change modifies a public API (HTTP route, exported function,
  CLI flag).
- The change touches a database schema (always pair with `schema-migration`).
- The user's request is ambiguous (multiple plausible interpretations).
- The task involves a refactor (anything starting "rename", "split",
  "extract", "move").
- The task takes >5 minutes of agent execution time.

**Skip plan-mode for**:
- "Read X and tell me what it does" → just do it
- "Fix this typo" → just do it
- Single-file bug fixes with a test that already exists
- Anything the user pre-approved with a clear plan in the request

## The Process

### 1. Write the plan as a structured proposal

Use this template (fill every section even if short):

```
## Goal
<one sentence — what success looks like>

## Approach
<3-6 bullets describing the strategy>

## Files I will touch
- packages/opencode/src/license/auth.ts (modify) — add revokeAllForCustomer
- packages/opencode/src/license/telegram.ts (modify) — wire the new helper into /logout
- packages/opencode/src/license/auth.test.ts (NEW) — coverage for the new fn

## Files I will NOT touch
<things adjacent that the user might assume — clear them out>

## Out of scope (will defer)
<things the user might want but aren't part of THIS plan>

## Risks
<what could go wrong, what would force a re-plan>

## Verification plan
<how I'll prove this works before claiming done>
```

### 2. Submit the plan, then STOP

Do not start writing code. Do not pre-emptively read files for the
implementation. Wait for the user to:
- Approve as-is
- Approve with changes ("yes, but skip step 3")
- Reject ("no, I want the opposite approach")
- Ask clarifying questions

### 3. On approval, execute step by step

Track each "Files I will touch" entry as a TodoWrite item. Mark in_progress
when starting it, completed when verified. Do not silently expand scope:

- Discover you need to touch a file not in the plan? **Stop and ask**:
  "I need to also modify `<file>` because <reason>. Add to plan or
  change approach?"

### 4. On completion, refer back to the plan

The wrap-up message should be plan-shaped:

```
✅ Plan executed:

  ✓ Goal: revoke-everywhere endpoint for the bot's /logout — done
  ✓ All listed files touched, no others
  ✓ Out-of-scope items (the renderer side) deferred as agreed
  ✓ Verification: 3 tests, both happy-path and empty-customer edge case

  No surprises during execution. 1 risk materialized:
  the existing /logout case in telegram.ts had inconsistent indentation,
  which I fixed in passing — flag that as a tiny in-scope cleanup.
```

## When the plan reveals a different problem

Sometimes writing the plan exposes that the user's framing was wrong.
**Say so**, don't quietly route around it:

```
Writing this plan, I noticed the proposed approach assumes
SessionTable.customer_id is populated, but our /experimental/sessions
endpoint never wires it. Three options:

  A) Continue with the plan, accept that legacy sessions stay invisible
     to the new filter
  B) Add a backfill query before the filter is enabled
  C) Delete the endpoint and route through /session/* (which we already scoped)

Pick one before I touch code.
```

## Red Flags

| Thought | Reality |
|---|---|
| "I'm just going to start, the plan is obvious" | NO. Plan is for *alignment*, not for you. |
| "The user is in a hurry, skip the plan" | The hurry is the plan's biggest value. |
| "I'll plan in my head" | Write it down. The user can't approve thoughts. |
| "Plan-mode is bureaucracy" | Rollbacks are bureaucracy. Plans are insurance. |
| "I planned it earlier in the conversation" | If the plan has drifted, re-plan. |

## Anti-pattern: silent scope creep

The most common failure mode is "I'll just also fix this thing while
I'm here". Don't. Plan it, get approval, then add it to the plan.

## Related skills

- `verification-before-completion` — runs the plan's "Verification
  plan" section
- `systematic-debugging` — if execution surfaces a new bug, that bug
  gets its own plan
