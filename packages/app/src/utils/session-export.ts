/**
 * Session export — turn a session's messages + metadata into a portable
 * artifact the user can share or archive. Two formats:
 *
 *   • Markdown — human-readable, suitable for sharing on GitHub /
 *     pasting into a doc. Each message is a heading + body block.
 *   • JSON — full event log shape, suitable for re-importing or
 *     programmatic analysis.
 *
 * Triggers a browser download via a temporary anchor + Blob URL. Works
 * in both desktop and web builds — the renderer is identical.
 */

export interface SessionMessageLike {
  /** Best-effort role marker — "user" / "assistant" / "system" / "tool". */
  role?: string
  /** Optional title (first session message often has one). */
  title?: string
  /** ISO 8601 timestamp. */
  time?: string
  /** Plain-text content (already rendered, no markdown post-processing). */
  text: string
}

export interface SessionExportInput {
  sessionId: string
  title?: string
  /** Filesystem path the session is anchored to, if any. */
  directory?: string
  createdAt?: number | string
  messages: SessionMessageLike[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

function safe(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "-").slice(0, 64) || "session"
}

function triggerDownload(filename: string, mime: string, body: string): void {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Free the blob after the click has fired — Chromium needs ~1 tick.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportSessionAsMarkdown(input: SessionExportInput): void {
  const lines: string[] = []
  lines.push(`# ${input.title ?? input.sessionId}`)
  lines.push("")
  lines.push(`*Session id:* \`${input.sessionId}\``)
  if (input.directory) lines.push(`*Directory:* \`${input.directory}\``)
  if (input.createdAt) {
    const created =
      typeof input.createdAt === "number" ? new Date(input.createdAt).toISOString() : input.createdAt
    lines.push(`*Created:* ${created}`)
  }
  lines.push(`*Exported:* ${nowIso()}`)
  lines.push("")
  lines.push("---")
  lines.push("")
  for (const m of input.messages) {
    const role = m.role ? m.role[0].toUpperCase() + m.role.slice(1) : "Message"
    const time = m.time ? ` · ${m.time}` : ""
    const title = m.title ? ` — ${m.title}` : ""
    lines.push(`## ${role}${title}${time}`)
    lines.push("")
    lines.push(m.text)
    lines.push("")
  }
  const filename = `${safe(input.title ?? input.sessionId)}-${stamp()}.md`
  triggerDownload(filename, "text/markdown;charset=utf-8", lines.join("\n"))
}

export function exportSessionAsJSON(input: SessionExportInput): void {
  const body = JSON.stringify(
    {
      schema: "crimecode.session.v1",
      exported_at: nowIso(),
      session: input,
    },
    null,
    2,
  )
  const filename = `${safe(input.title ?? input.sessionId)}-${stamp()}.json`
  triggerDownload(filename, "application/json;charset=utf-8", body)
}
