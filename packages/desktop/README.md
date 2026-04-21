# CrimeCode Desktop

Native CrimeCode desktop app, built with Tauri v2.

## Prerequisites

Building the desktop app requires additional Tauri dependencies (Rust toolchain, platform-specific libraries). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for setup instructions.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

## Build

```bash
bun run release:desktop:check
bun run release:desktop -- --kill
```

`release:desktop:check` builds the CLI, syncs the sidecar, runs the desktop frontend build, and finishes with `cargo check`.

`release:desktop` performs the same sidecar preparation, cleans stale release outputs, runs `tauri build`, and writes a checksum manifest to `src-tauri/target/release-<channel>-<target>.json`.

On Windows, pass `-- --kill` to stop a running `CrimeCode.exe` before packaging if `.exe` files are locked.

## Troubleshooting

### Rust compiler not found

If you see errors about Rust not being found, install it via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
