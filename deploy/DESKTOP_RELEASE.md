# Desktop Release Workflow

This repo publishes Windows installers to GitHub Releases on every `v*` tag via
the `.github/workflows/release-desktop-windows.yml` workflow.

## Quick start — cutting a release

```bash
# 1. Make sure master is clean and CI is green
git checkout master
git pull

# 2. Bump version in packages/desktop-electron/package.json if needed
# 3. Tag it
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions fires `Release Desktop Windows`, builds on a `windows-latest`
runner (~15–20 min), and publishes the installer at a stable URL.

## Public download URLs

Always-latest:
- https://github.com/flamematch23-lgtm/CrimeCode-IDE/releases/latest/download/opencode-electron-win-x64.exe
- https://github.com/flamematch23-lgtm/CrimeCode-IDE/releases/latest/download/latest.yml (for electron-updater)

Version-pinned (example `v1.0.0`):
- https://github.com/flamematch23-lgtm/CrimeCode-IDE/releases/download/v1.0.0/opencode-electron-win-x64.exe

## One-time setup: required GitHub secrets

The workflow reads three secrets. Set them at
**Settings → Secrets and variables → Actions → New repository secret**:

| Name | Required? | Value |
|------|-----------|-------|
| `OPENCODE_ADMIN_PASSPHRASE_SHA256` | Yes | SHA-256 hex of the admin passphrase (see `packages/desktop-electron/scripts/generate-admin-hash.ts`) |
| `SIGN_CERT_BASE64` | Optional | Base64 of a `.pfx` code-signing certificate. If unset, the installer ships unsigned (Windows SmartScreen will warn). |
| `SIGN_PASS` | Only if `SIGN_CERT_BASE64` is set | Password of the `.pfx` |
| `SIGN_PUBLISHER` | Optional | Publisher name shown in SmartScreen ("CrimeCode Dev (Self-signed)" works) |

### Encoding a self-signed cert

```powershell
# On your dev box
$bytes = [IO.File]::ReadAllBytes("packages/desktop-electron/sidecar/cert.pfx")
$b64 = [Convert]::ToBase64String($bytes)
Set-Clipboard -Value $b64
```

Then paste into the `SIGN_CERT_BASE64` secret on GitHub.

## What the workflow does

1. **Checkout** the tag
2. **Install Bun** 1.3.13 + workspace dependencies
3. **Build the CLI** (`packages/opencode/script/build.ts`) → produces the
   `opencode-cli.exe` sidecar that ships with every desktop install.
4. **Stage sidecar** into `packages/desktop-electron/sidecar/opencode-cli.exe`
5. **Decode cert** (optional) from `SIGN_CERT_BASE64` to
   `packages/desktop-electron/sidecar/cert.pfx`
6. **Build installer** via `bun run --cwd packages/desktop-electron build:win`
   (runs `scripts/build-win.ts` — electron-vite + electron-builder NSIS with
   the sidecar copied into unpacked resources)
7. **Publish** to GitHub Releases using `softprops/action-gh-release@v2`
   with the `.exe`, `.exe.blockmap`, and `latest.yml` (auto-updater manifest).

## Auto-updater

`electron-updater` in the app reads `latest.yml` from GitHub Releases and
downloads the delta based on the block map. No extra server infrastructure
needed — GitHub Releases IS the CDN.

To enable: verify `packages/desktop-electron/electron-builder.config.ts` has a
`publish:` section pointing at this repo. If absent, add:

```ts
publish: [
  {
    provider: "github",
    owner: "flamematch23-lgtm",
    repo: "CrimeCode-IDE",
  },
]
```

## Rolling a cert out-of-band

If you compromise the signing cert, rotate:

1. Generate a new `.pfx` (or buy a commercial CA cert)
2. Update the `SIGN_CERT_BASE64`, `SIGN_PASS`, `SIGN_PUBLISHER` secrets
3. Tag the next release (`git tag v1.0.1 && git push origin v1.0.1`)
4. Installs signed with the old cert remain valid; new installs use the new one.

## Rollback

If a release is broken:

1. Go to GitHub Releases → "Mark as pre-release" or delete the release
2. `electron-updater` will not auto-update past a deleted release
3. Tag a fixed version and push — auto-deploys in ~20 min.
