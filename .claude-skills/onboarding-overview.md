---
name: onboarding-overview
description: Use when first arriving in an unfamiliar repository. Produces a single-page structured summary (entry points, build commands, env vars, hot files, "next likely tasks") that turns a 30-tool-call cold start into a curated brief.
---

# Onboarding Overview

## Overview

The first ~30 tool calls in a new repo are usually the same: read the
README, list top-level dirs, find the build script, find the test
script, find the entry point. Replace that with a single-pass overview
that produces a one-page brief — both for the user and for the agent
itself to keep in context for the rest of the session.

## When to Use

- You've just been pointed at a new repo (no prior context).
- The user says "here's a new project, …".
- You haven't worked in this directory in this session before.
- You're about to start a multi-step task and want a stable mental
  model first.

**Don't skip when**:
- You think you know the repo (re-read — repos drift).
- The repo is small (still useful, takes 10 seconds).
- There's a CONTRIBUTING.md (read it, but produce the brief yourself —
  CONTRIBUTING.md is for humans, the brief is for the agent).

## The Process

Run the following steps in order. If any step fails (file missing,
command errors), record the failure and continue.

### 1. Repo identity

Run:
```bash
basename "$(pwd)"
git remote -v 2>/dev/null | head -1
git log --oneline -5 2>/dev/null
```

Capture: name, origin, last 5 commit subjects.

### 2. Top-level layout

```bash
ls -la
cat README.md 2>/dev/null | head -80
cat CHANGELOG.md 2>/dev/null | head -30
```

Note any of: `packages/` (monorepo), `apps/`, `services/`, `crates/`,
`cmd/`, `lib/`, `src/`. Each has different conventions.

### 3. Package manager + build system

Look for, in order:
- `package.json` → JS/TS, check `packageManager` field, list scripts
- `Cargo.toml` → Rust
- `go.mod` → Go
- `pyproject.toml` / `requirements.txt` → Python
- `Gemfile` → Ruby
- `Dockerfile*` → containerized
- `bun.lock`, `pnpm-lock.yaml`, `yarn.lock` → JS package manager hint
- `turbo.json`, `nx.json` → monorepo orchestrator

For monorepos, list packages:
```bash
ls -1 packages/ apps/ 2>/dev/null
```

### 4. Entry points

For each language, the conventional entry points:

- TS/JS: `package.json` `"main"` / `"bin"` field, `src/index.ts`,
  `src/main.ts`, `src/cli.ts`, `src/app.ts`
- Rust: `Cargo.toml` `[[bin]]` and `[lib]`, `src/main.rs`, `src/lib.rs`
- Go: `main.go`, `cmd/*/main.go`
- Python: `__main__.py`, console_scripts in `setup.cfg` / `pyproject.toml`

For an Electron / web app: `packages/desktop-electron/src/main/index.ts`,
`packages/app/src/entry.tsx`, `packages/app/src/app.tsx`.

### 5. Build / test / dev commands

From `package.json`:
```bash
jq '.scripts' package.json 2>/dev/null
```

For each script that's likely to be run, capture:
- `dev` / `start` — how to boot
- `build` — how to package
- `test` — how to run tests
- `typecheck` — how to verify types
- `lint` — how to lint

### 6. Environment variables

Find:
- `.env.example` / `.env.template`
- Top-level `process.env.X` references in entry files
- `Flag.X_NAME` in `flag/flag.ts` patterns

```bash
grep -rE "process\.env\.[A-Z_][A-Z0-9_]+" --include="*.ts" --include="*.tsx" -h | \
  grep -oE "process\.env\.[A-Z_][A-Z0-9_]+" | sort -u | head -30
```

### 7. Database / persistence

Look for:
- `migration/` directory → DB migrations (note the format: SQL files, Drizzle, Prisma…)
- `*.sql.ts` → Drizzle schemas
- `schema.sql` / `schema.prisma` → other ORMs
- `db.ts` / `database.ts` → connection wiring

### 8. Tests

```bash
find . -type f \( -name "*.test.*" -o -name "*.spec.*" \) -not -path "*/node_modules/*" | head -20
```

How are tests organized: alongside source (`foo.test.ts`), in a
`__tests__/` dir, in `tests/`, in `spec/`?

### 9. Hot files (recent commit activity)

```bash
git log --pretty=format: --name-only --since="30 days ago" 2>/dev/null | \
  grep -v '^$' | sort | uniq -c | sort -rn | head -10
```

The 10 files most-touched recently are usually where active work is
happening — read those first if the user's task is open-ended.

### 10. Open work signals

```bash
grep -rEn "TODO|FIXME|XXX|HACK" --include="*.ts" --include="*.tsx" --include="*.md" 2>/dev/null | wc -l
ls .github/ISSUE_TEMPLATE/ 2>/dev/null
gh pr list --limit 5 2>/dev/null
```

Number of TODOs, presence of issue templates, current open PRs.

## Output Format

Produce **exactly one** brief. Use this template:

```
# <repo-name> overview

**Origin**: <remote>
**Recent**: <last commit subject>

## Layout
- Type: <monorepo / single-package / multi-service>
- Languages: <e.g. TypeScript primary, some Rust>
- Workspaces: <if monorepo, list packages>

## Entry points
- <path>: <what it does>
- ...

## How to work in it
- Boot: `<command>`
- Test: `<command>`
- Typecheck: `<command>`
- Lint: `<command>`
- Build: `<command>`

## Environment
Required: <list>
Optional: <list>

## Persistence
- DB: <description>
- Migrations live in: <path>
- Schema files: <path pattern>

## Where the activity is
- Hot files (last 30 days, top 5):
  - <file> — <count> commits
  - ...
- Open TODOs: <count>
- Open PRs: <count>

## Likely first tasks (if user is open-ended)
1. <first plausible thing based on hot files / TODOs>
2. <second>
3. <third>

## Risks / things I noticed
- <e.g. "no `.env.example` — env vars are inferred from grep">
- <e.g. "tests live both in tests/ and alongside source — pick one">
```

## Red Flags

- "I'll just dive in, the file is obvious" — no, do the brief. The
  follow-up tool calls will reuse this knowledge.
- "The README explains everything" — READMEs lie. Verify with the
  actual files.
- "The repo is small" — still produce the brief; it's 30 seconds and
  pays off on every subsequent call.

## Related skills

- `verification-before-completion` — verifies the boot/build commands
  found here actually work
- `pre-commit-review` — once you make a change, this skill provides
  the test/typecheck/lint commands to run
