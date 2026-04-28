---
name: security-review-on-diff
description: Run a focused security pass on a code diff before commit. Catches the high-frequency vulns (SQLi, hardcoded secrets, auth bypass, path traversal, missing rate limit, weak crypto) at the moment they're being introduced — not at audit time.
---

# Security Review on Diff

## Overview

Most security bugs are introduced when "making it work in a hurry".
This skill runs a security checklist scoped to the diff so the pass
takes seconds, not hours, and the vulnerable code never lands.

This is **not** a replacement for a full security audit — it's the
first line. Run it on every diff that touches:

- Authentication / authorization
- Database queries (especially raw SQL or string interpolation)
- HTTP endpoints (input validation, response shape)
- File system operations (paths, includes, uploads)
- Crypto / signing / hashing
- Secrets / env vars / config

## When to Use

Trigger automatically when a diff touches any of:

```
**/auth/**         **/license/**       **/server/routes/**
**/middleware/**   **/storage/db*      **/crypto*
**/*.sql.ts        **/*.sql            **/payments/**
```

Or manually on demand: "review this for security".

## The Checklist

### 1. SQL injection

Look for any of these in the diff:

```
db\.prepare\([^)]*\$\{        # template literal in prepare
db\.exec\(.+\$\{               # template literal in exec
.run\(\s*[^,)]*\+              # string concat with run args
WHERE.*=.*\+                    # WHERE x = ... + var
"SELECT.*'" \+ .*\+            # quoted concat
```

**Rule**: every parameter into SQL must be a `?` placeholder bound at
`.run(...)` / `.get(...)` / `.all(...)` time. **Never** template literals.

```typescript
// ✗ BAD
db.exec(`SELECT * FROM users WHERE name = '${name}'`)
// ✓ GOOD
db.prepare("SELECT * FROM users WHERE name = ?").get(name)
```

### 2. Hardcoded secrets

```regex
(api[_-]?key|secret|password|hmac[_-]?secret|private[_-]?key)
  \s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']
sk-[A-Za-z0-9]{20,}            # OpenAI
ghp_[A-Za-z0-9]{30,}            # GitHub PAT
xox[a-z]-[0-9-]+                # Slack
[0-9]{8,}:[A-Za-z0-9_-]{30,}    # Telegram bot token
```

**Rule**: zero hardcoded secrets in the repo. Always env or a secrets
manager. If a secret has been **committed** even once, treat it as
leaked: rotate immediately, force-push only if you fully understand
the consequences (else `git filter-repo` the history out and rotate).

### 3. Authentication on every route

For each new HTTP route in the diff, verify:

- Does it require auth? If yes, is auth enforced *before* any state
  read/write?
- What's the auth scope? (Bearer customer scope, admin Basic auth,
  public no-auth — each clearly different)
- For admin routes: is `getAdminUserIds()` / `makeAdminAuth()` actually
  applied at the route, not just *near* it?

```typescript
// ✗ BAD — token check happens AFTER db read
app.post("/sensitive", async (c) => {
  const user = await db.getUser(c.req.query("id"))
  const auth = c.req.header("Authorization")
  if (!auth) return c.json({error: "unauthorized"}, 401)
  // ...
})

// ✓ GOOD — guard at top
app.post("/sensitive", async (c) => {
  const sess = sessionGuard(c)
  if (!sess) return c.json({error: "unauthorized"}, 401)
  const user = await db.getUser(sess.sub)
  // ...
})
```

### 4. Authorization (after authentication)

Verify the caller is allowed to operate on the *specific* resource:

- Route param `:cid` → does the caller's customer_id actually equal
  `:cid`, or is the caller an admin?
- DELETE on a row → does the row belong to the caller?
- POST a comment → is the parent thread visible to the caller?

The pattern from this codebase:

```typescript
const sessions = listSessionsForCustomer(customerId)
const owns = sessions.some((s) => s.id === sid)
if (!owns) throw new HTTPException(404, { message: "device not found" })
```

The 404 (not 403) on missing-ownership is intentional: it doesn't leak
the existence of the resource for someone else.

### 5. Path traversal

Look for any user input that ends up in a filesystem path:

```regex
fs\.(readFile|writeFile|stat|unlink)Sync?\([^)]*req\.       # raw req in fs op
path\.join\([^)]*req\.                                       # joining req with FS root
url\.searchParams\.get.*\.\.                                 # ".." in user-supplied path
```

**Rule**: every user-supplied path must be validated:

```typescript
const requested = path.resolve(rootDir, userInput)
if (!requested.startsWith(rootDir + path.sep)) {
  throw new HTTPException(400, { message: "path escapes root" })
}
```

### 6. Rate limit on expensive endpoints

Endpoints that:
- Authenticate users (login, password verify, signup)
- Send emails / SMS / Telegram messages
- Trigger payments / external API calls
- Search large data sets

…must have rate-limiting. Check for:

```typescript
import { checkRateLimit } from "./rate-limit"
const ok = checkRateLimit(`auth.signin:${ip}`, 5, 60)
if (!ok) return c.json({ error: "too_many_requests" }, 429)
```

If the endpoint is new and lacks this guard → flag it.

### 7. Weak crypto

```regex
crypto\.createHash\(['"]md5['"]\)         # MD5
crypto\.createHash\(['"]sha1['"]\)        # SHA-1
Math\.random\b                            # for security purposes
```

Use:
- Hashing: `sha256` minimum, `sha512` for keys
- Random: `crypto.randomBytes()` / `crypto.randomUUID()`
- HMAC: `crypto.createHmac("sha256", secret)`
- Password hashing: `scrypt` or `argon2id` (see `auth.ts`'s `hashPassword`)

### 8. Token in URL / log

```regex
\?access_token=     # token in query string
\?token=            # ditto
console\.log\(.+(token|jwt|secret|password)
log\.(info|warn|error)\(.+(token|jwt|password)
```

**Rule**: tokens go in `Authorization: Bearer …` headers, never in URLs.
This codebase fixed exactly this bug in v2.22.18 (POST /events-stream
replacing `?access_token=`). Don't reintroduce it.

### 9. Missing input validation

For each HTTP body / query param:

- Is there a Zod schema or `validator(...)` middleware?
- Are string lengths capped? (1MB JSON bombs)
- Are arrays length-capped? (a million elements would OOM)
- Are integer ranges checked? (negative / huge values)

```typescript
const body = z.object({
  name: z.string().min(1).max(64),
  count: z.number().int().min(0).max(1000),
  tags: z.array(z.string().max(32)).max(20),
}).parse(await c.req.json())
```

### 10. Open redirects

```regex
res\.redirect\([^)]*req\.                  # redirect to user-supplied URL
window\.location.*req\.query                # client-side
```

If the destination URL comes from user input, verify it's an allowlist
of internal hosts.

## Red Flags

| Thought | Reality |
|---|---|
| "I'll add the auth check later" | NO. Auth-less routes ship to prod. |
| "It's an internal API, no need for validation" | "Internal" usually means "exposed via misconfig at some point". |
| "The user can't easily craft this payload" | Yes they can. Validate. |
| "We trust this header" | Don't. Headers are user-controlled. |

## Output Format

```
🔒 Security review — packages/opencode/src/server/routes/account.ts

  Findings (1 high, 2 medium, 0 low):

  HIGH    line 47 — DELETE /me/devices/:sid passes :sid to revokeSession
                    without verifying the session belongs to the caller.
                    Add: listSessionsForCustomer(cid).some(s => s.id === sid)
                    before the call. Otherwise any authenticated caller
                    can revoke any session.

  MEDIUM  line 72 — POST /me/devices/logout-all has no rate limit.
                    Suggest: checkRateLimit(`logout:${cid}`, 5, 60).

  MEDIUM  line 89 — GET /me/audit accepts ?limit= without an upper bound.
                    Add: Math.min(limit, 500).

  Approve to land? (y / fix-then-recheck / abandon)
```

## Related skills

- `pre-commit-review` — runs after this, includes a quick secrets re-scan
- `schema-migration` — when DB shape changes, re-run this on the
  migration code as well as the consumers
