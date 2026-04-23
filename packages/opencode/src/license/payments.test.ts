import { describe, expect, test } from "bun:test"
import { paymentUri, withDiscriminator } from "./payments"

describe("license/payments", () => {
  test("withDiscriminator is deterministic for the same order id", () => {
    const base = 18_000n
    const a = withDiscriminator(base, "ord_42")
    const b = withDiscriminator(base, "ord_42")
    expect(a).toBe(b)
  })

  test("withDiscriminator differs across order ids", () => {
    const base = 18_000n
    const a = withDiscriminator(base, "ord_aaa")
    const b = withDiscriminator(base, "ord_bbb")
    expect(a).not.toBe(b)
  })

  test("withDiscriminator offset always in [0, 99_999]", () => {
    const base = 0n
    for (const id of ["ord_x", "ord_y", "ord_9999999", "a-very-long-order-id-indeed-really"]) {
      const r = withDiscriminator(base, id)
      expect(r >= 0n).toBe(true)
      expect(r < 100_000n).toBe(true)
    }
  })

  test("paymentUri builds a BIP21 URI for BTC", () => {
    const uri = paymentUri("BTC", "bc1qd2sasjw895mhaft8gmjj9v2hgeehzf5dc0a9p7", 18_245n)
    expect(uri.startsWith("bitcoin:bc1qd2sasjw895mhaft8gmjj9v2hgeehzf5dc0a9p7?amount=")).toBe(true)
    // 18_245 sat = 0.00018245 BTC
    expect(uri.includes("0.00018245")).toBe(true)
  })

  test("paymentUri builds an ETH URI using wei", () => {
    // 1 ETH in wei
    const uri = paymentUri("ETH", "0x67477189CDB6ED66Ce1acBc2533a16ab680274bd", 10n ** 18n)
    expect(uri.startsWith("ethereum:0x67477189CDB6ED66Ce1acBc2533a16ab680274bd?value=")).toBe(true)
    expect(uri.includes(`value=${(10n ** 18n).toString()}`)).toBe(true)
  })
})
