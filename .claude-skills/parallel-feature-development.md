---
name: parallel-feature-development
description: Use when working on two or more features in parallel and you don't want to keep stashing/branching/context-switching. Sets up git worktrees so each feature lives in its own directory with its own state, your IDE / agent has a coherent view per feature, and merging back into one PR per feature is clean.
---

# Parallel Feature Development with Worktrees

## When to Use

- You're juggling 2+ feature branches and the constant
  `git stash` / `git switch` / re-install / re-bootstrap dance is
  killing your throughput.
- You want to run an agent (or yourself) on feature A while a long
  build / test runs on feature B.
- You're triaging a hotfix on `main` while a feature branch is
  half-done — and you don't want to commit the WIP just to switch.

**Don't use** for short interruptions (<30 min). For those, `git
stash` is fine.

## Why Worktrees Beat Branch-Switching

Git worktrees give you N working directories backed by ONE `.git`:

- Each worktree has its own checked-out branch and its own working
  tree state. No stashing.
- Switching is `cd ../feature-b` — instant. No re-install of
  node_modules, no rebuilding TypeScript declarations, no losing
  IDE state.
- Pushing, fetching, branching all go through the same git history.
  Worktrees aren't forks; they're alternate views.

Cost: each worktree is a full copy of your source tree (not the .git
metadata, but yes the source files). Disk-wise: ~50-200 MB per
worktree depending on the repo. Today's not-a-problem.

## The Setup

### 1. Create the worktrees directory

```bash
# Conventional location: a sibling directory `.worktrees`
# (already in this repo's .gitignore).
mkdir -p .worktrees
```

This repo already has `.worktrees` gitignored — confirm:
```bash
grep '^\.worktrees' .gitignore
```

### 2. Add a worktree per feature

```bash
# Create a new branch + worktree in one shot:
git worktree add .worktrees/feature-a -b feat/feature-a

# Or attach an existing branch:
git worktree add .worktrees/hotfix-x hotfix/x
```

You now have:

```
opencode-main/
├── .git/                  ← shared git data
├── packages/              ← your normal main checkout
└── .worktrees/
    ├── feature-a/         ← branch feat/feature-a checked out
    └── hotfix-x/          ← branch hotfix/x checked out
```

### 3. Bootstrap each worktree

Each worktree needs its OWN `node_modules` because of how Bun /
pnpm / npm hardlink hoisted deps:

```bash
cd .worktrees/feature-a
bun install
```

For a monorepo with many packages, you can speed this up by using a
shared package store (Bun + pnpm support content-addressed storage).
The first `bun install` per worktree is slow; subsequent ones reuse
the global store.

### 4. List + manage

```bash
git worktree list           # show all worktrees + their branches
git worktree remove .worktrees/feature-a   # delete worktree (branch survives)
git worktree prune          # clean up stale entries (after manual rm)
```

## Working in Multiple Worktrees

### Different terminals per worktree

```bash
# Terminal 1
cd /repo/.worktrees/feature-a
bun run dev

# Terminal 2
cd /repo/.worktrees/feature-b
bun test --watch
```

If your editor has a "open folder in new window" command, point each
window at the corresponding worktree. The two windows share the .git
metadata so any commit in one shows up in the other immediately.

### Sharing changes between worktrees

You don't need to push to a remote to move a commit between
worktrees:

```bash
# In worktree A — stash a fix that turned out to belong on main:
cd .worktrees/feature-a
git commit -m "fix: stuff that should land on main"

# In worktree B (main):
cd ../../
git cherry-pick feat/feature-a~0     # or the SHA
```

Pulling a remote commit into both is also one-step:

```bash
cd /repo
git fetch origin
cd .worktrees/feature-a
git rebase origin/main         # or merge
```

## Coordination With the Agent

When the agent (or you) is working autonomously on multiple branches
in parallel:

1. **One TODO list per worktree.** Don't share a TodoWrite plan
   across worktrees — they'll bleed scope.
2. **Distinct ports per worktree** if you run dev servers
   simultaneously. Bake into a `.env.local` per worktree.
3. **Per-worktree journals.** A `.claude/journal-<feature>.md` in
   each lets the agent record state without trampling the other
   feature's notes.
4. **Single source of truth for the queue**: `git worktree list`
   in the repo's main directory. Don't try to track worktrees in a
   doc — they go stale.

## Hotfix Workflow

The killer use case:

```bash
# You're 3 hours into a feature in your main checkout.
# Production is on fire. Without losing your work:

cd /repo
git worktree add .worktrees/hotfix main

cd .worktrees/hotfix
git switch -c hotfix/critical-thing
# … fix, test, push, merge, deploy.

cd ../../        # Back to your feature, exactly as you left it.
git worktree remove .worktrees/hotfix
```

No `git stash`. No "sorry, I lost my place". Just two checkouts
running in parallel.

## Long-running Compute Workflow

You can run two agents in parallel without conflict:

```bash
# Worktree A — agent runs the migration tests in a 20-min loop.
cd .worktrees/feat-schema-v2
bun test --watch &

# Worktree B — agent works on the unrelated UI feature.
cd ../../.worktrees/feat-export-button
# … real edit/test/commit work, IDE happy.
```

The two worktrees can't fight over the same files because they're
different files. They share git history, so when you push both to
origin, GitHub sees them as ordinary branches.

## Anti-patterns

| Don't | Why |
|-------|-----|
| Manipulate `.git/worktrees/*` by hand | Use `git worktree` commands; the metadata is structured. |
| Put a worktree inside another worktree | Git won't stop you, but recursive `git status` becomes a mess. |
| Forget to remove worktrees you're done with | Stale checkouts hide on disk; `git worktree list` reveals them. |
| Use a worktree for a temporary `git checkout -- file` revert | Way overkill — just stash. |
| Symlink between worktrees | Breaks `.gitignore` resolution; treat them as fully independent trees. |
| Run `git worktree remove` while inside that worktree | You'll delete the cwd you're standing in. cd out first. |

## Common Pitfalls

- **Bun / pnpm postinstall scripts**: some run only on
  fresh installs. Their absence in a sister worktree can cause
  confusing "missing native module" errors. Re-run `bun install` in
  the worktree where it broke.
- **IDE TypeScript service**: VS Code's TS server caches per-folder.
  Each worktree gets its own cache, which is what you want — but
  expect a brief reindex when you first open it.
- **`.claude/scheduled_tasks.lock`** (or any per-session lock):
  this file is per-process, not per-worktree. If you run two agents
  in parallel they may both try to acquire. Solution: gitignore it
  (already done in this repo) and let each agent own its own.

## Worked Example

```bash
# I'm halfway through a payment-system feature when an /order page bug
# report comes in.

# 1. Park the WIP — without committing it.
cd /c/Users/mango/Desktop/opencode-main
git worktree add .worktrees/bug-order main

# 2. Switch over.
cd .worktrees/bug-order
bun install
git switch -c fix/order-modal-overlap

# 3. Fix + test + commit.
# … edit, run-tests-for.ts, commit, push, open PR.

# 4. Back to feature work, untouched.
cd ../../
# Working tree is exactly where I left it. Continue.
```

## Related skills

- **resume-after-crash** — for recovering inside a single worktree.
- **multi-agent-dispatch** — for fanning out subagents within ONE
  worktree on independent concerns.
- **dependency-update-safety** — set up a worktree per dep upgrade
  to keep them isolated.
