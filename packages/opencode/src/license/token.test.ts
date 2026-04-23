import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { expiryFor, makeToken, verifyToken } from "./token"

const prev = process.env.LICENSE_HMAC_SECRET
beforeAll(() => {
  process.env.LICENSE_HMAC_SECRET = "unit-test-secret-thats-long-enough-to-pass-32-char-check"
})
afterAll(() => {
  if (prev === undefined) delete process.env.LICENSE_HMAC_SECRET
  else process.env.LICENSE_HMAC_SECRET = prev
})

describe("license/token", () => {
  test("makeToken returns a CC2-prefixed string with 3 parts", () => {
    const { token } = makeToken({ l: "lic_1", i: "monthly", t: 1000 })
    expect(token.startsWith("CC2-")).toBe(true)
    const [, body, sig] = token.match(/^CC2-([^.]+)\.(.+)$/) ?? []
    expect(body.length).toBeGreaterThan(0)
    expect(sig.length).toBeGreaterThan(0)
  })

  test("roundtrip: sign then verify returns the same payload", () => {
    const { token } = makeToken({ l: "lic_a", i: "annual", t: 2_000_000, e: 2_000_000 + 3600 })
    const v = verifyToken(token)
    expect(v.ok).toBe(true)
    if (!v.ok || !v.payload) return
    expect(v.payload.l).toBe("lic_a")
    expect(v.payload.i).toBe("annual")
    expect(v.payload.t).toBe(2_000_000)
    expect(v.payload.e).toBe(2_000_000 + 3600)
  })

  test("tampered payload fails verification", () => {
    const { token } = makeToken({ l: "lic_1", i: "monthly", t: 1000 })
    // Flip one character in the payload segment.
    const cheat = token.replace("CC2-", "CC2-X")
    const v = verifyToken(cheat)
    expect(v.ok).toBe(false)
  })

  test("tampered signature fails verification", () => {
    const { token } = makeToken({ l: "lic_1", i: "monthly", t: 1000 })
    const idx = token.lastIndexOf(".")
    const cheat = token.slice(0, idx + 1) + "A" + token.slice(idx + 2)
    const v = verifyToken(cheat)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe("bad_sig")
  })

  test("bad prefix rejected immediately", () => {
    const v = verifyToken("FAKE-abc.def")
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe("bad_prefix")
  })

  test("expiryFor: monthly = 31 days, annual = 366, lifetime = undefined", () => {
    const issued = 1_000_000
    expect(expiryFor("monthly", issued)).toBe(issued + 31 * 86400)
    expect(expiryFor("annual", issued)).toBe(issued + 366 * 86400)
    expect(expiryFor("lifetime", issued)).toBeUndefined()
  })
})
