import { $ } from "bun"

import { binaryPath, copyBinaryToSidecarFolder, getCurrentSidecar, hostTarget } from "./utils"

const target = Bun.env.TAURI_ENV_TARGET_TRIPLE ?? hostTarget()

const sidecarConfig = getCurrentSidecar(target)

const file = binaryPath(target)

await (sidecarConfig.ocBinary.includes("-baseline")
  ? $`cd ../opencode && bun run build --single --baseline`
  : $`cd ../opencode && bun run build --single`)

await copyBinaryToSidecarFolder(file, target)
