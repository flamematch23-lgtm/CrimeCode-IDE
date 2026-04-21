# Upstream .gitignore Proposal (for `anomalyco/opencode`)

The downstream fork `flamematch23-lgtm/CrimeCode-IDE` discovered during a routine
push that the root `.gitignore` was missing exclusions for binary artifacts. A
prior contributor had committed executables totaling 800+ MB, including three
files over GitHub's 100 MB hard limit:

- `packages/desktop-electron/sidecar/opencode-cli.exe` (177 MB)
- `packages/relay/relay.exe` (115 MB)
- `opencode-desktop-windows-x64.exe` (110 MB)
- ~12 additional binaries under `.dist/bun-cache/` totaling ~400 MB

These break `git push` to any GitHub remote. The `.dist/` directory is a
`bun-cache` artifact and should never be version-controlled. The `.exe`/`.dll`
files are build outputs produced from source packages in the monorepo.

## Proposed patch

```diff
--- a/.gitignore
+++ b/.gitignore
@@ -28,3 +28,18 @@ opencode-dev
 logs/
 *.bun-build
 tsconfig.tsbuildinfo
+
+# Binary artifacts (never commit — GitHub rejects files over 100MB)
+.dist/
+*.exe
+*.dll
+packages/desktop-electron/sidecar/opencode-cli.exe
+packages/relay/relay.exe
+
+# Windows-reserved device names accidentally created by shell redirects
+/nul
+
+# Certificates / secrets — never commit private keys
+*.pfx
+*.pem
+*.key
```

## Companion cleanup (one-time, if the upstream history already contains them)

If upstream has these files in its history (check with
`git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk '$1=="blob" && $3 > 50000000'`)
use `git filter-repo` to rewrite history:

```bash
pip install git-filter-repo
git filter-repo \
  --path .dist \
  --path packages/desktop-electron/sidecar/opencode-cli.exe \
  --path packages/relay/relay.exe \
  --path opencode-desktop-windows-x64.exe \
  --path ngrok.exe \
  --invert-paths
```

WARNING: history rewrite requires coordinated re-cloning for every contributor.
Do not run on `main` without maintainer agreement.

## Suggested GitHub issue text

> **Title:** `.gitignore` missing binary artifact exclusions (causes GitHub push rejection)
>
> **Body:**
>
> Cloning and pushing this repo to a fresh GitHub remote fails with
> `remote end hung up unexpectedly` because `packages/desktop-electron/sidecar/opencode-cli.exe`
> (177 MB) exceeds GitHub's 100 MB per-file hard limit. The file is a build
> output, not source. The root `.gitignore` currently does not exclude any of
> the binary artifacts produced by `bun build` / `electron-builder`.
>
> Proposed fix: add `.dist/`, `*.exe`, `*.dll`, `*.pfx`, `*.pem`, `*.key`,
> and `/nul` (for Windows shell accidents) to `.gitignore`. See diff below.
>
> (paste the diff block above)
>
> Happy to open a PR if you accept the approach.

## Why not LFS?

Git LFS solves "large files in repo" but:
1. GitHub's free LFS tier is 1 GB bandwidth/month — consumed in one clone by
   anyone who wants to build the project.
2. These are **build outputs**, not source. They should be produced by CI and
   published as release assets, not version-controlled.

The right architecture is: source in Git, binaries in GitHub Releases / CI
artifacts. This proposal enforces that boundary at the `.gitignore` level.
