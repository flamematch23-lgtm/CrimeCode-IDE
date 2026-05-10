// Stage @zed-industries/claude-code-acp + all transitive deps into
// `resources/claude-code-acp/`. Electron-builder copies that dir to
// `process.resourcesPath/claude-code-acp/` in the installer; the sidecar
// reads OPENCODE_CLAUDE_CODE_ACP_ENTRY pointing at
// `<resources>/claude-code-acp/dist/index.js` and spawns it with `node`.
//
// Why we install fresh instead of copying from the workspace's bun cache:
// the bun-hoisted `node_modules/.bun/<pkg>+<hash>/node_modules/` only
// contains DIRECT deps of <pkg>, not transitive ones (e.g. minimatch is
// there but `brace-expansion` it requires is hoisted up one level into
// the workspace root). Trying to walk the dep graph by hand is fragile
// — instead we let bun do it: an isolated dir with one dependency on
// @zed-industries/claude-code-acp gets a flat, complete `node_modules`
// with every transitive dep.

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, copyFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { execSync } from "node:child_process"

const ROOT = resolvePath(import.meta.dir, "..")
const REPO_ROOT = resolvePath(ROOT, "../..")
const STAGE_DIR = join(ROOT, "resources", "claude-code-acp")
const ACP_VERSION =
  // Pin to the same version we declared in opencode/package.json so we
  // don't accidentally ship a different one to users.
  "0.16.2"

console.log(`stage-claude-acp: clearing ${STAGE_DIR}`)
if (existsSync(STAGE_DIR)) rmSync(STAGE_DIR, { recursive: true, force: true })
mkdirSync(STAGE_DIR, { recursive: true })

// Step 1 — minimal package.json so bun install knows what to fetch.
writeFileSync(
  join(STAGE_DIR, "package.json"),
  JSON.stringify(
    {
      name: "@opencode-ai/claude-code-acp-bundle",
      private: true,
      version: "0.0.0",
      dependencies: {
        "@zed-industries/claude-code-acp": ACP_VERSION,
      },
    },
    null,
    2,
  ),
)

// Step 2 — install with bun in production mode + linker=hoisted so the
// node_modules layout is the standard one Node can resolve at runtime.
// `--no-save` keeps our tiny package.json untouched for next time.
console.log("stage-claude-acp: bun install (this may take a moment)")
execSync("bun install --production --no-save --backend=copyfile --linker=hoisted", {
  cwd: STAGE_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    // Skip lifecycle scripts in transitive deps — none are needed at
    // runtime and some try to spawn build tools we don't have.
    npm_config_ignore_scripts: "true",
  },
})

// Step 3 — flatten so the entry script lives at top-level (matches what
// the OPENCODE_CLAUDE_CODE_ACP_ENTRY env var assumes:
// `<resources>/claude-code-acp/dist/index.js`).
//
// IMPORTANT: electron-builder silently STRIPS any directory named
// `node_modules` from `extraResources` (legacy behavior to avoid
// duplicating modules with the main app's node_modules). To work around
// this we rename node_modules → vendor in the staged dir, and the
// runtime side (acp-client.ts) creates a `node_modules` junction
// pointing at `vendor` on first spawn so Node's ESM resolver finds the
// deps. Without this, the installed bundle ends up missing every
// dependency and the adapter crashes with "Cannot find package
// 'minimatch'" or similar on first import.
const acpInstalled = join(STAGE_DIR, "node_modules", "@zed-industries", "claude-code-acp")
if (!existsSync(acpInstalled)) {
  throw new Error(`bun install completed but ${acpInstalled} doesn't exist`)
}

function copyDirSync(src: string, dst: string, skipNames: Set<string> = new Set()) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue
    const sp = join(src, entry.name)
    const dp = join(dst, entry.name)
    let st
    try {
      st = statSync(sp)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      // Skip dev junk
      if (
        entry.name === ".bin" ||
        entry.name === ".cache" ||
        entry.name === "test" ||
        entry.name === "tests" ||
        entry.name === "__tests__" ||
        entry.name === ".github"
      ) continue
      copyDirSync(sp, dp)
    } else if (st.isFile()) {
      // Skip files that are useless at runtime (saves ~30% of bundle size).
      if (
        entry.name.endsWith(".d.ts") ||
        entry.name.endsWith(".d.ts.map") ||
        entry.name.endsWith(".js.map") ||
        entry.name.endsWith(".test.js") ||
        entry.name.endsWith(".test.cjs") ||
        entry.name.endsWith(".test.mjs")
      ) continue
      copyFileSync(sp, dp)
    }
  }
}

// Move the @zed-industries/claude-code-acp folder up to STAGE_DIR root,
// keep the sibling node_modules/ in place. After this:
//   STAGE_DIR/dist/index.js              ← entry
//   STAGE_DIR/package.json
//   STAGE_DIR/node_modules/@agentclientprotocol/...
//   STAGE_DIR/node_modules/diff/...
//   STAGE_DIR/node_modules/minimatch/...
//   STAGE_DIR/node_modules/brace-expansion/...      ← transitive — included
console.log(`stage-claude-acp: flattening ${acpInstalled} → ${STAGE_DIR}`)
const TEMP_NM = join(STAGE_DIR, "node_modules")
const TEMP_ZED = join(TEMP_NM, "@zed-industries")
copyDirSync(acpInstalled, STAGE_DIR, new Set(["node_modules"]))
// Drop the now-unused @zed-industries dir to save space.
rmSync(TEMP_ZED, { recursive: true, force: true })

// Sanity: list top-level deps that were staged.
const staged = readdirSync(TEMP_NM)
const scoped = staged
  .filter((d) => d.startsWith("@"))
  .flatMap((scope) => {
    try {
      return readdirSync(join(TEMP_NM, scope)).map((sub) => `${scope}/${sub}`)
    } catch {
      return []
    }
  })
const flat = staged.filter((d) => !d.startsWith("@"))
const all = [...scoped, ...flat].sort()
console.log(`stage-claude-acp: staged ${all.length} deps`)
console.log(`stage-claude-acp: deps: ${all.join(", ")}`)

// Step 4 — RENAME node_modules → vendor. electron-builder strips
// directories named `node_modules` from extraResources targets (legacy
// dedup). We rename so the dir survives the package step; the runtime
// (acp-client.ts) creates a `node_modules` junction back to `vendor` on
// first spawn so Node's resolver finds the deps.
import { renameSync } from "node:fs"
const VENDOR_DIR = join(STAGE_DIR, "vendor")
if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true })
renameSync(TEMP_NM, VENDOR_DIR)

// Drop `.bin/` from vendor — bun install populates it with symlinks
// pointing into ../<pkg>/dist/cli.js etc. On macOS code signing
// (electron-builder) walks every file in Resources/ and chokes on
// dangling symlinks (target stripped by our copyDirSync filter or by
// the package not shipping a CLI), failing with:
//   ENOENT: no such file or directory, stat '.../vendor/.bin/claude-code-acp'
// The .bin entries are CLI shims for npm scripts — useless at runtime
// for our use case (we spawn `node dist/index.js` directly).
const VENDOR_BIN = join(VENDOR_DIR, ".bin")
if (existsSync(VENDOR_BIN)) {
  rmSync(VENDOR_BIN, { recursive: true, force: true })
  console.log(`stage-claude-acp: removed vendor/.bin (symlinks break macOS codesigning)`)
}

console.log(`stage-claude-acp: renamed node_modules → vendor (electron-builder workaround)`)
console.log(`stage-claude-acp: done → ${STAGE_DIR}`)
