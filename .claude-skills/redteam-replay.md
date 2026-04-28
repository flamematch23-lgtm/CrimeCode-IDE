---
name: redteam-replay
description: Use ONLY when an authorised security engagement requires replaying a payload corpus against a target service to identify vulnerabilities. Mandatory consent + scope + audit guardrails. Designed for the security-research and authorised-pentest audience that CrimeCode IDE is built for — never for unauthorised testing.
---

# Redteam Payload Replay

## Overview

Security researchers and authorised pentesters need to:

- Replay a corpus of payloads (XSS, SQLi, fuzz, custom) against a
  target endpoint
- Compare responses to spot anomalies (5xx vs 4xx, length deltas,
  reflected payload, timing)
- Capture an audit trail for the engagement report

This skill is the **only** way to do that inside CrimeCode IDE — by
design, going through it forces the safety rails: explicit scope,
explicit consent, full audit log, rate limit, off-by-default destructive
verbs (DELETE, PUT to mutating endpoints).

## The hard rules

1. **Authorised targets only**. The skill refuses to run against any
   target not explicitly listed in the engagement file (see step 2).
2. **No skill execution without a signed engagement**. The agent does
   NOT attempt to "guess" what's allowed.
3. **Loopback + RFC1918 + explicit allowlist only**. Public endpoints
   are blocked unless the engagement file lists them with a
   `confirmed_authorisation_url`.
4. **Read-mostly defaults**. Mutating verbs (POST/PUT/PATCH/DELETE)
   require an additional `--allow-mutating` flag AND a confirmation
   prompt.
5. **Hard rate limit**. Default 5 req/sec with jitter, configurable up
   to 20 r/s in the engagement file. Anything higher is rejected.
6. **Full audit log**. Every request + response is written to a
   timestamped JSON-Lines file under
   `.redteam-engagements/<id>/audit-<timestamp>.jsonl`. Tampering with
   the file invalidates the engagement.
7. **Stop on credential capture**. If a response body contains anything
   matching the secrets-regex set, the runner halts immediately and
   marks the engagement requires human review.

## When to Use

- An authorised security engagement (internal red team, contracted
  pentest, bug bounty with explicit scope) needs payload replay.
- A staging / QA environment owned by the user needs vulnerability
  validation.
- A CI security gate is checking a known-vulnerable corpus against a
  fixed staging URL.

**NEVER use this for**:
- Targets the user does not own
- Production systems without an incident-response on standby
- "Just to see if it works" — security tools have legal consequences
- Unauthorised bug bounty hunting outside the program's scope

If the user requests a use case in any of the above categories, the
agent **must refuse** and explain the limitation.

## The Process

### 1. Engagement file

Create or load `.redteam-engagements/<engagement-id>.json`:

```json
{
  "engagement_id": "internal-staging-2026-04",
  "authorised_by": "ciso@company.com",
  "authorisation_evidence": "Slack #security 2026-04-25 13:42 UTC",
  "scope": {
    "targets": [
      {
        "name": "staging-api",
        "base_url": "http://10.0.5.42:3000",
        "rate_limit_rps": 10
      },
      {
        "name": "auth-service",
        "base_url": "https://auth.staging.company.example",
        "rate_limit_rps": 5,
        "confirmed_authorisation_url": "https://internal.company.example/redteam/2026-04"
      }
    ],
    "paths_allow": ["/api/*", "/login", "/search"],
    "paths_deny": ["/admin/*", "/billing/*"],
    "allow_mutating": false
  },
  "valid_until": "2026-05-15T00:00:00Z",
  "stop_on_secret": true,
  "audit_dir": ".redteam-engagements/internal-staging-2026-04/audit"
}
```

### 2. Pre-flight check

The runner refuses to start unless:

- The engagement file exists and parses
- `valid_until` is in the future
- The target's `base_url` is one of:
  - 127.0.0.1 / ::1 / localhost (loopback)
  - RFC1918 (10.x, 172.16-31.x, 192.168.x)
  - A public URL listed with a non-empty `confirmed_authorisation_url`
- The user re-types the engagement_id at the prompt

### 3. Run the replay

```bash
bun script/agent-tools/redteam-replay.ts \
  --engagement .redteam-engagements/internal-staging-2026-04.json \
  --target staging-api \
  --corpus payloads/xss.jsonl \
  --confirm "I have explicit authorisation to test internal-staging-2026-04"
```

### 4. Read the audit log

Every line of `audit-<ts>.jsonl` records:

```json
{
  "ts": "2026-04-28T14:30:12.124Z",
  "request": { "method": "GET", "url": "http://...", "headers": {...}, "payload_id": "xss-001" },
  "response": { "status": 200, "headers": {...}, "body_sha256": "...", "body_length": 4321 },
  "anomaly": null
}
```

`anomaly` is one of:
- `null` — looks normal
- `"5xx"` — server error
- `"reflected_payload"` — the payload appears verbatim in the response
- `"length_delta"` — response length deviates >5σ from baseline
- `"slow"` — response time > 5× median
- `"secret_in_response"` — secrets-regex matched, runner halted

### 5. Triage

Filter the audit log for anomalies:

```bash
jq -r 'select(.anomaly != null) | "\(.ts) \(.anomaly) \(.request.url)"' \
  .redteam-engagements/.../audit-*.jsonl
```

Each anomaly becomes a finding in the engagement report. The audit
log is the evidence trail — keep it for the lifetime of the
engagement.

## Red Flags

| Thought | Reality |
|---|---|
| "I'll skip the engagement file just for a quick test" | NO. The file IS the consent record. |
| "The user said they own it, that's enough" | The engagement file is the user's chance to be specific about WHAT they own. Without it, ambiguity = liability. |
| "Let me bypass the rate limit, I need it faster" | The rate limit protects YOU as much as the target. Don't bypass. |
| "This is a public bug bounty, no engagement needed" | Yes it is. Bounty programs have scopes — encode them in the file. |
| "I'll run mutating verbs, the user will tell me to stop if it breaks" | NO. Default deny. Explicit allow per engagement. |

## Related skills

- `security-review-on-diff` — for code review (defensive); this skill
  is for live testing (offensive). Different context, same mindset.
- `verification-before-completion` — after replay, verify the audit
  log is well-formed and findings reproduce.

## Legal & ethical

This skill assumes the user has the right to test the target. The agent
does not verify legal authorisation — that's the user's responsibility.
Misusing this skill against systems you don't own may be a felony in
many jurisdictions. The engagement file is your audit trail; treat it
like a contract.
