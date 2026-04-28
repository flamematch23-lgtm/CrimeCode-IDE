#!/usr/bin/env bun
/**
 * Estimate the agent's remaining context budget by counting bytes/tokens
 * of the conversation transcript piped on stdin (or read from a file).
 *
 * Token estimation is rough — we use a 4-bytes-per-token heuristic which
 * is accurate to within ~10% for English code-heavy content. Good enough
 * for "you have ~30% left, start pruning".
 *
 * Usage:
 *   bun script/agent-tools/token-budget-estimate.ts < transcript.txt
 *   bun script/agent-tools/token-budget-estimate.ts ~/.local/share/opencode/sessions/<id>/transcript.json
 *   echo "$LARGE_TEXT" | bun script/agent-tools/token-budget-estimate.ts --window 200000
 *
 * Output:
 *   used_bytes:    1842331
 *   est_tokens:    460582  (≈ 230% of 200k window — DANGER)
 *   utilisation:   2.30
 *   remaining:     -260582 tokens
 *   advice:        "Heavy pruning required — context is over budget."
 */

const args = process.argv.slice(2)
let window = 200_000
let path: string | null = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--window" && args[i + 1]) {
    window = Number.parseInt(args[i + 1], 10)
    i++
    continue
  }
  if (!args[i].startsWith("--")) path = args[i]
}

async function readInput(): Promise<string> {
  if (path) return await Bun.file(path).text()
  // stdin — Bun's ReadableStream isn't typed as async-iterable in some
  // bun-types versions, so use .getReader() which is universally typed.
  const reader = Bun.stdin.stream().getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const text = (await readInput()).trim()
const bytes = Buffer.byteLength(text, "utf8")
// Rough token estimate. Real BPE tokens vary 3-5 bytes for code; 4 is the
// honest middle. Returns slightly-pessimistic numbers, which is what we
// want when deciding "should I prune?".
const est = Math.round(bytes / 4)
const util = est / window

let advice: string
if (util < 0.3) advice = "Healthy — plenty of room."
else if (util < 0.55) advice = "Comfortable. Compress long tool outputs as you go."
else if (util < 0.75) advice = "Watch — start pruning stale Reads now (see context-pruning skill)."
else if (util < 0.95) advice = "Heavy pruning recommended — invoke context-pruning skill."
else advice = "Over budget — invoke context-pruning skill or end session."

console.log(`used_bytes:   ${bytes}`)
console.log(`est_tokens:   ${est}  (≈ ${(util * 100).toFixed(1)}% of ${window})`)
console.log(`utilisation:  ${util.toFixed(2)}`)
console.log(`remaining:    ${window - est} tokens`)
console.log(`advice:       ${JSON.stringify(advice)}`)
