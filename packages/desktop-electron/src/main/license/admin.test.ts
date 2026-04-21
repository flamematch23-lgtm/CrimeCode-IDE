import { describe, expect, test, mock } from "bun:test"

// Stub electron + electron-store: both are pulled in transitively by
// `./admin` → `../constants` / `./service` → `../store`, and neither is
// usable under `bun test` (electron's index.js only exports a path string,
// and electron-store's constructor calls `app.getPath` at module load).
const electronStub = {
  app: { isPackaged: false, getPath: () => process.cwd(), getVersion: () => "0.0.0" },
  ipcMain: { on: () => {}, handle: () => {} },
  ipcRenderer: { sendSync: () => ({}) },
  shell: {},
}
mock.module("electron", () => ({ ...electronStub, default: electronStub }))
class FakeStore {
  private data = new Map<string, unknown>()
  get(key: string) { return this.data.get(key) }
  set(key: string, value: unknown) { this.data.set(key, value) }
}
mock.module("electron-store", () => ({ default: FakeStore }))

const { sha256Hex, passphraseMatches } = await import("./admin")

describe("sha256Hex", () => {
  test("returns the correct digest for a known string", async () => {
    // sha256("opencode") =
    const digest = await sha256Hex("opencode")
    expect(digest).toBe("62f8e1ec095e1857446d403d1431007de8813aea9553a56ccd4552a131b1f297")
  })
})

describe("passphraseMatches", () => {
  test("matches when input hashes to expected digest", async () => {
    const expected = await sha256Hex("secret")
    expect(await passphraseMatches("secret", expected)).toBe(true)
  })

  test("does not match when input differs", async () => {
    const expected = await sha256Hex("secret")
    expect(await passphraseMatches("wrong", expected)).toBe(false)
  })

  test("returns false on empty expected digest", async () => {
    expect(await passphraseMatches("secret", "")).toBe(false)
  })

  test("is case-insensitive on the expected digest", async () => {
    const expected = (await sha256Hex("secret")).toUpperCase()
    expect(await passphraseMatches("secret", expected)).toBe(true)
  })
})
