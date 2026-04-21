#!/usr/bin/env bun
/**
 * Utility to generate the SHA-256 hex digest of the admin passphrase for
 * OpenCode Desktop's Pro subscription admin panel.
 *
 * Usage:
 *   bun packages/desktop-electron/scripts/generate-admin-hash.ts "my-passphrase"
 *   # or pipe via stdin:
 *   echo -n "my-passphrase" | bun packages/desktop-electron/scripts/generate-admin-hash.ts
 *
 * Copy the printed hex value into your build environment:
 *   OPENCODE_ADMIN_PASSPHRASE_SHA256=<hex>
 *
 * NEVER commit the passphrase or its hash to the repo. Use a build-time secret
 * store (GitHub Actions secrets, Vercel env vars, etc.).
 */

import { createHash } from "node:crypto"

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8").trimEnd()
}

async function main() {
  const arg = process.argv[2]
  const passphrase = arg ?? (await readStdin())

  if (!passphrase) {
    console.error("Error: passphrase is empty. Pass as argv[2] or via stdin.")
    process.exit(1)
  }

  if (passphrase.length < 12) {
    console.warn(
      "Warning: passphrase is shorter than 12 characters. Consider using a longer, high-entropy value.",
    )
  }

  const digest = createHash("sha256").update(passphrase, "utf8").digest("hex").toLowerCase()
  console.log(digest)
}

main().catch((err) => {
  console.error("Failed to hash passphrase:", err)
  process.exit(1)
})
