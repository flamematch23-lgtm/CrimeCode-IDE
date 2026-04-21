# Admin Panel — Build-time Configuration

The Pro subscription admin panel (`packages/desktop-electron/src/main/license/admin.ts`) uses a **passphrase gate** in beta and prod builds. In `dev` builds the panel is auto-unlocked.

## 1. Generate the passphrase hash

Pick a high-entropy passphrase (20+ chars). This is your master credential — treat it like a root password.

```bash
# argv mode
bun packages/desktop-electron/scripts/generate-admin-hash.ts "your-very-long-passphrase-here"

# stdin mode (preferred — no shell history leak)
printf 'your-very-long-passphrase-here' | bun packages/desktop-electron/scripts/generate-admin-hash.ts
```

Output example:
```
644122ccfb9ae7f848d29e31309ae2840325f2ce999909d5f15eff1be7bfdc09
```

## 2. Pass the hash at build time

The hash is read from `import.meta.env.OPENCODE_ADMIN_PASSPHRASE_SHA256` and is inlined by `electron-vite` / `tsgo` at compile time. Never read it at runtime.

### Local beta build

```powershell
# Windows PowerShell
$env:OPENCODE_CHANNEL = "beta"
$env:OPENCODE_ADMIN_PASSPHRASE_SHA256 = "644122ccfb9ae7f848d29e31309ae2840325f2ce999909d5f15eff1be7bfdc09"
bun run --cwd packages/desktop-electron build
```

```bash
# macOS / Linux
export OPENCODE_CHANNEL=beta
export OPENCODE_ADMIN_PASSPHRASE_SHA256=644122ccfb9ae7f848d29e31309ae2840325f2ce999909d5f15eff1be7bfdc09
bun run --cwd packages/desktop-electron build
```

### GitHub Actions

```yaml
- name: Build desktop (beta)
  env:
    OPENCODE_CHANNEL: beta
    OPENCODE_ADMIN_PASSPHRASE_SHA256: ${{ secrets.OPENCODE_ADMIN_PASSPHRASE_SHA256 }}
  run: bun run --cwd packages/desktop-electron build
```

Store the hash (not the plaintext) in `repository secrets`.

## 3. Behavior matrix

| Channel | Env var set? | Admin panel |
|---------|-------------|-------------|
| `dev` | — | Auto-unlocked (no prompt) |
| `beta` | yes | Locked, passphrase required |
| `beta` | no | Menu hidden (see `menu.ts` `visible` flag) |
| `prod` | yes | Locked, passphrase required |
| `prod` | no | Menu hidden |

## 4. Rotating the passphrase

1. Generate a new hash (step 1)
2. Update the secret in CI
3. Re-build and ship
4. Old builds with the previous hash keep working — they check the hash embedded at THEIR build time

There is no runtime override. If you lose the passphrase, ship a new build.

## 5. Security notes

- `timingSafeEqual` compare: even with equal-length inputs, the compare is constant-time to prevent side-channel.
- Case-insensitive: both the stored hash and the input-derived hash are lowercased before compare.
- Minimum length: the utility warns if the passphrase is shorter than 12 chars. 20+ is recommended.
- Never log the plaintext or the hash from within the app — the hash is printed only by the build-time utility.
