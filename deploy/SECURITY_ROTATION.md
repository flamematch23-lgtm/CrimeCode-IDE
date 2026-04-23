# Security Rotation Checklist

Credentials and tokens that were exposed in chat transcripts or need to be
rotated before going broadly public.

## 🔴 High priority — rotate before any public announcement

### 1. Server password (`OPENCODE_SERVER_PASSWORD`)

**Current (exposed in chat):** `ECYVLWUExelFreTUVCG0QJHO0rcuCay9`

Rotate:
```bash
# Generate new password (32 random chars, no shell-special)
NEW_PASS=$(bun -e 'const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; const b=crypto.getRandomValues(new Uint8Array(32)); console.log(Array.from(b, x => c[x%c.length]).join(""))')
echo "$NEW_PASS"

# Apply to Fly
fly secrets set OPENCODE_SERVER_PASSWORD="$NEW_PASS" --app crimecode-api

# The web login form and any installed desktop app will ask for this on
# next open. Don't lose it — store in 1Password/Bitwarden.
```

### 2. Admin passphrase (`OPENCODE_ADMIN_PASSPHRASE_SHA256`)

**Current (exposed):** `vES%TFs2NLl@9hl^eH3dpcYQVMqcOb5m`  
SHA-256: `127fa3baa33eb833ad821b66ebd4f5617cda3efeacfe2f3281843621ab613351`

Rotate:
```bash
# Generate new + hash
NEW_PASS=$(bun -e 'const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!@%^="; const b=crypto.getRandomValues(new Uint8Array(32)); console.log(Array.from(b, x => c[x%c.length]).join(""))')
NEW_HASH=$(bun packages/desktop-electron/scripts/generate-admin-hash.ts "$NEW_PASS")
echo "Passphrase: $NEW_PASS"
echo "SHA-256:    $NEW_HASH"

# Update GitHub secret (affects next release build)
gh secret set OPENCODE_ADMIN_PASSPHRASE_SHA256 --repo flamematch23-lgtm/CrimeCode-IDE --body "$NEW_HASH"

# Cut a new release tag to rebuild with new hash
git tag v1.1.1
git push origin v1.1.1
```

## 🟡 Medium priority — developer tokens (short-lived anyway)

### 3. GitHub PAT

**Exposed in chat:** one `ghp_…` PAT with `repo` scope.

Revoke: https://github.com/settings/tokens → delete `opencode-push-temp`

Replacement: GitHub CLI `gh auth login` (short-lived OAuth token, no manual PAT needed).

### 4. Cloudflare API Token

**Exposed:** three `cfut_…` user tokens shared in chat during setup
(first IP-filtered, second no-IP-filter and used by the `CLOUDFLARE_API_TOKEN`
CI secret, third used to verify Pages domains for `crimecode.cc`).
All three must be revoked together.

Revoke: https://dash.cloudflare.com/profile/api-tokens → delete all three.

Replace the CI one:
1. Create new token (same scope: Cloudflare Pages: Edit, no IP filter, 7-day TTL)
2. `gh secret set CLOUDFLARE_API_TOKEN --repo flamematch23-lgtm/CrimeCode-IDE --body "<new-cfut>"`

### 5. Fly.io API Token

**Exposed** in chat — set as CI secret `FLY_API_TOKEN` (format `FlyV1 fm2_…`).

Revoke:
```bash
fly tokens list | grep deploy
fly tokens revoke <id>
```

Replace:
```bash
NEW_FLY=$(fly tokens create deploy --app crimecode-api --expiry 8760h)
gh secret set FLY_API_TOKEN --repo flamematch23-lgtm/CrimeCode-IDE --body "$NEW_FLY"
```

## 🟢 Low priority — self-signed cert

**Current:** `packages/desktop-electron/sidecar/cert.pfx`, pwd `testcert2026`, thumbprint `550D367724C6415080B16F1E5A93AF6E65A47C76`

This cert is gitignored and only used for local self-signed builds. CI currently
skips signing entirely (`SIGN_*` secrets removed). Windows SmartScreen shows
"Unknown Publisher" warning regardless. For real distribution:

1. Buy an OV or EV code-signing cert (~$250–500/year, e.g. Sectigo, DigiCert)
2. Add back the CI secrets `SIGN_CERT_BASE64`, `SIGN_PASS`, `SIGN_PUBLISHER`
3. Workflow auto-decodes and signs.

## Verification

After rotation:
```bash
# Server
curl -I https://api.crimecode.cc/  # should get 401 with WWW-Authenticate

# Admin panel (desktop app, dev channel, unlocked)
# Or in beta/prod, enter the new passphrase in the AdminPanel unlock form

# CI
gh secret list --repo flamematch23-lgtm/CrimeCode-IDE
# All 4 secrets should have recent `updated at` timestamps
```

## Recovery

If you lose the server password:
```bash
fly ssh console --app crimecode-api --command 'cat /proc/1/environ | tr "\\0" "\\n" | grep OPENCODE_SERVER_PASSWORD'
```

If you lose the admin passphrase:  
There is no recovery — the desktop binary has the SHA-256 hash baked in. Ship
a new build with a new hash (`git tag v*` triggers the release workflow).
