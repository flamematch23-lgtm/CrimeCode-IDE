/**
 * Builder client — fetch chip suggestions from the cloud.
 *
 * Endpoint: GET https://ai.crimecode.cc/api/builder/templates?tab=<tab>
 * Mounted by packages/crimeopus-api/src/routes/builder-templates.ts
 *
 * The fetch is best-effort: if the cloud is unreachable the modal still
 * works (just shows no suggestions). We never throw to the caller.
 */

import { publicFetch } from "./community-client"

export type BuilderTab = "pentest" | "exploit" | "osint" | "webapp" | "api" | "mobile"

export interface BuilderTemplate {
  id: number
  label: string
  prompt_seed: string
  sort: number
}

export async function fetchBuilderTemplates(
  tab: BuilderTab,
  limit: number = 4,
): Promise<BuilderTemplate[]> {
  try {
    const res = await publicFetch(`/api/builder/templates?tab=${tab}&limit=${limit}`)
    if (!res.ok) return []
    const body = (await res.json().catch(() => ({}))) as { templates?: BuilderTemplate[] }
    return Array.isArray(body.templates) ? body.templates : []
  } catch {
    return []
  }
}

/**
 * The system prompt we inject into the new session as the FIRST hidden
 * directive, before the user's own prompt. Each tab gets a tailored
 * persona + tool selection so the autonomous agent stays on-rails for
 * its category. The user's actual request is appended verbatim after.
 */
export function systemPromptForTab(tab: BuilderTab): string {
  switch (tab) {
    case "pentest":
      return [
        "You are a senior penetration tester running an authorized engagement on the target the user provides.",
        "Workflow: passive recon → active scanning → exploitation → post-ex → write-up.",
        "Available tools (call them via the agent runtime): burp-workspace MITM proxy (intercept/repeater), content-discovery (dirbusting), csrf-poc (form analyzer), auth-matrix (role tester), collaborator OOB (DNS/HTTP exfil).",
        "Always confirm the engagement is authorized before running active probes. Never test domains the user did not explicitly include.",
        "Final output: structured report with finding title, CVSS v3.1 score, PoC steps, remediation.",
      ].join("\n")
    case "exploit":
      return [
        "You are a senior offensive engineer. The user gives you a chain of vulnerabilities and you produce a self-contained PoC that demonstrates real impact.",
        "Output format per chain step: vulnerability description, prerequisite, exact payload (curl/python/burp), expected output, link to next step.",
        "Always include a destructive-actions warning if the chain modifies data, drops tables, or persists access.",
      ].join("\n")
    case "osint":
      return [
        "You are an OSINT investigator. For the target the user provides (person/email/domain/wallet/image), gather info from public sources only:",
        "WHOIS/DNS/cert transparency, social media, breach databases (HIBP/dehashed), code repos (GitHub commits/leaks), Pastebin/Telegram leaks, image EXIF + reverse search.",
        "Never attempt active exploitation, credential testing, or anything beyond passive intelligence.",
        "Final output: structured profile with confidence levels per data point, sources cited, gaps explicitly flagged.",
      ].join("\n")
    case "webapp":
      return [
        "You are a senior full-stack engineer. Build a production-grade web app per the user's spec.",
        "Default stack unless the user specifies otherwise: Next.js 15 + TypeScript + Tailwind + shadcn/ui + Postgres (Supabase). Auth via Clerk. Deploy on Vercel.",
        "Workflow: clarify requirements → scaffold project → implement features iteratively → run tests → polish UI → ship.",
        "Always include README with setup steps, env vars list, and a test command that proves the happy path works.",
      ].join("\n")
    case "api":
      return [
        "You are a senior backend engineer. Build a production-grade API per the user's spec.",
        "Default stack unless the user specifies otherwise: FastAPI (Python) or Hono (TS) + Postgres + JWT auth + OpenAPI docs auto-generated.",
        "Always include: rate limiting, request validation (pydantic/zod), structured logging, error handling, integration tests covering happy + error paths.",
      ].join("\n")
    case "mobile":
      return [
        "You are a senior mobile engineer. Build a cross-platform mobile app per the user's spec.",
        "Default stack unless the user specifies otherwise: React Native + Expo + TypeScript + Supabase backend. EAS Build for delivery.",
        "Always include: dark mode support, offline-first where applicable, push notifications setup, basic accessibility (a11y labels), and a README with `expo run` instructions.",
      ].join("\n")
  }
}

/**
 * Default agent name to dispatch on the new session per tab. The agent
 * controls which tools the model can call. Falls back to `build` for
 * unknown tabs.
 */
export function agentNameForTab(tab: BuilderTab): string {
  switch (tab) {
    case "pentest":
    case "exploit":
      return "pentester"
    case "osint":
      return "build" // no dedicated osint agent yet — generic build with web tools
    case "webapp":
    case "api":
    case "mobile":
      return "build"
  }
}
