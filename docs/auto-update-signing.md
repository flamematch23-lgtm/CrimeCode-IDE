# Update signing

Minisign key infrastructure for Tauri auto-updates.

---

## Understand the system

CrimeCode uses Tauri's built-in updater with minisign signatures. Every release artifact is signed with a private key during CI, and the desktop app verifies signatures against a public key baked into the Tauri config.

The signing private key only exists as a GitHub Secret. If the key is absent at build time, auto-updates are compiled out entirely.

---

## Know the architecture

**Tauri configs** — three configs live in `packages/desktop/src-tauri/`:

| File                   | Purpose | Updater |
| ---------------------- | ------- | ------- |
| `tauri.conf.json`      | Dev     | None    |
| `tauri.prod.conf.json` | Prod    | Enabled |
| `tauri.beta.conf.json` | Beta    | Enabled |

Prod and beta share the same minisign public key but point to different release endpoints:

- Prod: `https://github.com/anomalyco/crimecode/releases/latest/download/latest.json`
- Beta: `https://github.com/anomalyco/crimecode-beta/releases/latest/download/latest.json`

**Compile-time flag** — in `packages/desktop/src-tauri/src/constants.rs`:

```rust
pub const UPDATER_ENABLED: bool = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();
```

This compiles to `false` when the env var is missing, disabling the updater at the binary level.

**Frontend** — `packages/desktop/src-tauri/src/windows.rs` injects the flag into the webview:

```js
window.__CRIMECODE__.updaterEnabled = true // or false
```

Then `packages/desktop/src/updater.ts` reads it and conditionally calls `check()` from `@tauri-apps/plugin-updater`.

**CI** — `.github/workflows/publish.yml` passes two env vars to `tauri-apps/tauri-action`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

**Post-build** — `packages/desktop/scripts/finalize-latest-json.ts` rebuilds `latest.json` with per-platform download URLs and `.sig` signatures pulled from the GitHub release assets.

---

## Generate keys

Use the Tauri CLI to create a minisign keypair:

```sh
bun tauri signer generate -w ~/.tauri/crimecode.key
```

This produces two things:

1. A private key file at `~/.tauri/crimecode.key` (password-protected)
2. A public key printed to stdout

Save both. The private key and its password go into GitHub Secrets. The public key goes into the Tauri configs.

---

## Configure GitHub secrets

In your GitHub repo, go to **Settings > Secrets and variables > Actions** and create two repository secrets:

| Secret                               | Value                                    |
| ------------------------------------ | ---------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Full contents of the private key file    |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password you chose during key generation |

The publish workflow already references these secrets. No workflow changes needed.

---

## Develop locally

Local builds won't have `TAURI_SIGNING_PRIVATE_KEY` set, so `UPDATER_ENABLED` compiles to `false`. This is expected — the updater menu item won't appear and no update checks will run.

If you need to test the updater locally, export both env vars before building:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/crimecode.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password"
bun tauri build
```

---

## Troubleshoot

**"A public key has been found, but no private key"** — Tauri sees `plugins.updater.pubkey` in the config but `TAURI_SIGNING_PRIVATE_KEY` is not set. This only happens when building with a prod/beta config locally. Either set the env var or build with the dev config.

**Signature verification failed** — the public key in the Tauri config doesn't match the private key that signed the artifact. Make sure `pubkey` in both `tauri.prod.conf.json` and `tauri.beta.conf.json` matches your keypair.

**Updates disabled in CI build** — verify the GitHub Secrets are set and the workflow is passing them to the build step. Check the `tauri-apps/tauri-action` step logs for signing output.

---

## Rotate keys

1. Generate a new keypair:
   ```sh
   bun tauri signer generate -w ~/.tauri/crimecode.key
   ```
2. Update the `pubkey` field in both `tauri.prod.conf.json` and `tauri.beta.conf.json`.
3. Replace the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Secrets with the new values.
4. Cut a new release.

Users on older versions won't be able to verify the new signatures. They'll need to download the new version manually — this is a one-time break.
