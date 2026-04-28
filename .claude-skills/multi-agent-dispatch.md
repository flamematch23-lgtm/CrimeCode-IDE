---
name: multi-agent-dispatch
description: Use when a task naturally decomposes into specialist concerns (review, test, debug, security). Fan out subtasks to focused sub-agents instead of cramming everything through one generalist context — better quality per token, parallel speedup.
---

# Multi-Agent Dispatch

## Overview

A single generalist agent doing security review + writing tests +
implementing the feature has to context-switch constantly. Specialist
sub-agents each focused on one slice produce sharper output for the
same total token spend.

This skill is about **when** and **how** to fan out.

## When to Use

Trigger fan-out for any of:

- Security-sensitive change → spawn a separate `security-review` agent
  on the diff before merging.
- Performance change with a benchmark → spawn a `performance-review`
  agent that runs the benchmark and reports.
- Multi-component bug → spawn a `debug` agent per component (renderer,
  server, sidecar) and merge findings.
- Large refactor → main agent plans, sub-agents execute leaf rewrites
  in parallel.
- Documentation pass → spawn a `docs-writer` agent on the changed
  files in parallel with the main work.

**Do not fan out**:
- For tasks that fit in a single 30-tool-call session.
- For tasks where the sub-agent would need almost all of the parent's
  context (just bloats the dispatch overhead).
- When the cost of coordination > cost of doing it inline.

## The Process

### 1. Identify the slices

Before dispatch, the parent agent writes:

```
=== Dispatch plan ===

Subtask A: security-review-on-diff for the new auth flow
  Inputs: diff of packages/opencode/src/license/auth.ts
  Subagent: superpowers:code-reviewer (security focus)
  Expected output: list of findings with severity + remediation

Subtask B: write E2E test for /account/me/license
  Inputs: route file, sample customer + license fixtures
  Subagent: general-purpose (test-writing focus)
  Expected output: a packages/opencode/tests/account-license.test.ts
  that passes and covers happy + 401 + 404 paths

Subtask C: typecheck + lint
  Inputs: same diff
  Subagent: Explore (read-only, fast)
  Expected output: pass/fail + first 5 errors if any
```

### 2. Dispatch in one batch

If the subtasks are independent, fire them **in parallel** with a
single message containing multiple Agent tool uses. The parent agent
keeps its context lean by NOT reading the inputs in detail — it
delegates that.

### 3. Merge the results

When all sub-agents return:

```
=== Merge ===

Subtask A (security): 1 high finding — 401 path doesn't drop
  webSession on 401 cascade. Patched.
Subtask B (E2E test): test added, all 4 cases green.
Subtask C (typecheck/lint): 13/13 packages clean.

All clear. Ready to commit.
```

### 4. Report back to the user

The user sees one summary, not three intermediate reports. The
sub-agent transcripts stay collapsed unless the user asks.

## Sub-agent contracts

Each sub-agent must respect:

| Constraint | Reason |
|---|---|
| Self-contained prompt | Sub-agent has no memory of parent's context |
| Specific output shape | Parent needs to merge — un-merged blobs = manual rework |
| Stay in scope | Sub-agent that "while I'm here" creep is worse than no sub-agent |
| Bounded length | "Report under 200 words" beats "report fully" |

## Common patterns

### Pattern: "fan out then re-converge"

Parent plans → fan out to N specialist sub-agents (parallel) → each
returns a structured slice → parent merges into one coherent action.

Best for: **independent** subtasks. Bad for: tasks that depend on each
other's output.

### Pattern: "pipe through specialists"

Parent → security-review → if any HIGH finding, fix → re-review →
test-writer → e2e — sequential, each stage gates the next.

Best for: **release pipelines**. Cost: latency (no parallelism).

### Pattern: "main + watcher"

Main agent does the work; a watcher sub-agent periodically reads
the changes-so-far and flags drift from the plan. Less common —
useful for very long sessions.

## Red Flags

| Thought | Reality |
|---|---|
| "I'll do all of it myself, faster" | At 50+ tool calls, faster ≠ better |
| "I'll spawn 5 sub-agents for variety" | More sub-agents = more merge work, not better answers |
| "Each sub-agent will figure out the context" | They won't. Brief them like a stranger walked in. |
| "I'll use the sub-agent's full output verbatim" | Distill. The user wants your synthesis, not the raw sub-call. |

## Tooling

In this codebase, dispatch sub-agents via the `Agent` tool:

```
Agent({
  description: "Security review of auth diff",
  subagent_type: "superpowers:code-reviewer",
  prompt: "Review the diff in packages/opencode/src/license/auth.ts:200-250 for ...
           Report findings as: severity, file:line, fix proposal. Cap 200 words."
})
```

For parallel dispatch, send multiple `Agent` tool uses **in a single
message** so they execute concurrently.

## Related skills

- `plan-before-execute` — the dispatch plan IS a plan; show it to the
  user before fan-out.
- `verification-before-completion` — runs after merge.
