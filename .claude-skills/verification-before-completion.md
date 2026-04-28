---
name: verification-before-completion
description: Use BEFORE telling the user a task is done. Forces a self-verification pass (typecheck + targeted tests + spawn-and-curl for service changes) so "done" actually means done. The most common UX failure is "agent said done, user tried it, it didn't work".
---

# Verification Before Completion

## Overview

The most common dissatisfying interaction is:

1. Agent: "Done! I've fixed the bug."
2. User: tries it
3. User: "It doesn't work."

This pattern is preventable. Before declaring "done", run a verification
pass appropriate to the change. **Saying "done" without verification is
a lie**, even if you believe it.

## When to Use

Trigger before any of:
- "Done", "fixed", "shipped", "ready", "complete"
- Closing a TodoWrite item that the user is waiting on
- Returning control to the user after a multi-step task
- Replying to "is it working now?"

**Do not skip when**:
- You're confident — confidence is exactly when verification catches you
- The change is small — small changes break things just as often
- You already ran the test once two minutes ago — re-run, you might have
  modified state since

## The Process

### 1. Identify what kind of change this is

Pick the right verification:

| Change kind | Verification |
|---|---|
| Pure logic / fn refactor | Targeted unit test must pass |
| New HTTP endpoint | spawn server + curl with expected + edge inputs |
| New CLI command | invoke command, assert exit code + stdout |
| Schema migration | fresh-DB boot + table_info inspection |
| UI component | typecheck + render once (no visual regression check possible — flag for human) |
| Bot command | log shows the new branch fires; ideally fake-message integration test |
| Build pipeline | local `bun run build` succeeds |

### 2. Run typecheck

Always. Even for "tiny" changes.

```bash
bun run typecheck
```

If a turbo monorepo: rerun from the package root if there are
incremental cache concerns.

### 3. Run the targeted tests

If a tests file already covers the change, run only those:

```bash
bun packages/opencode/script/agent-tools/run-tests-for.ts <changed-files>
```

If no tests exist:
- For pure logic / a known bug: write a failing test first, see it
  fail, fix the code, see it pass.
- For UI / orchestration: at minimum write an "import works" smoke test
  so future regressions are caught.

### 4. End-to-end probe

For server changes:

```bash
# Start the server with isolated DB, hit the endpoint, verify shape.
TESTDB="/tmp/verify-$RANDOM.db"
OPENCODE_DB=$TESTDB OPENCODE_SERVER_PASSWORD=test \
  bun run --cwd packages/opencode src/index.ts serve --port 0 > /tmp/srv.log 2>&1 &
PID=$!
sleep 3
curl -s -u opencode:test http://127.0.0.1:<port>/<your-endpoint>
kill $PID
```

For renderer changes: build once, check for runtime errors:

```bash
bun run --cwd packages/desktop-electron build
```

### 5. Compare against the original goal

Re-read the user's original request. Does what you just verified
*actually answer* it? If the user said "fix the login bug for empty
passwords", and your verification only covers the happy path, you
haven't verified the fix.

### 6. Produce the verification block

Don't just say "done". Show what you verified:

```
✅ Verified

  • typecheck (13/13 packages)            pass
  • targeted tests (3 in auth.test.ts)    pass
  • E2E:
      - POST /auth/signin (good creds)    200 + token
      - POST /auth/signin (empty pwd)     400 "missing_password"
      - POST /auth/signin (bad pwd)       401 "bad_credentials"

Bug confirmed fixed. Returning control.
```

If verification fails, **do not** report "done" — report the failure
and the next step:

```
⚠ Verification incomplete — typecheck passed but the E2E probe failed:

  POST /auth/signin (empty pwd) → 500 (expected 400)

  Root cause: the new validation throws before the catch block. Need
  to wrap in try/catch. Will fix and re-verify.
```

## Red Flags

| Thought | Reality |
|---|---|
| "It compiled, that's enough" | Compiling != working. Run the test. |
| "The user will tell me if it's broken" | The user shouldn't be your test runner. |
| "I'll write the test in a follow-up" | The follow-up never happens. Write it now. |
| "I tested it manually two messages ago" | State has changed. Test again. |
| "The change is so small it can't break" | Tiny diff + skipped test = highest-density bug. |

## Anti-pattern: claiming success on stale evidence

Don't claim success based on a test run from before the latest change.
If you edited a file in tool calls 5-7 and last ran the test in tool
call 4, the test result is stale. Re-run.

## Related skills

- `pre-commit-review` — runs before commit; verification-before-completion
  runs before *return-to-user*. They compose.
- `systematic-debugging` — when verification fails, this is the next skill
  to invoke (root cause before fix #2).
