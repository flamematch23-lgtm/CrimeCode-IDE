import { afterEach, describe, expect, test } from "bun:test"
import { __resetRateLimitBuckets, checkRateLimit } from "./rate-limit"

afterEach(() => __resetRateLimitBuckets())

describe("license/rate-limit", () => {
  test("default limit is 10 per minute", () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit("default-test")
      expect(r.ok).toBe(true)
      expect(r.remaining).toBe(10 - (i + 1))
    }
    const over = checkRateLimit("default-test")
    expect(over.ok).toBe(false)
    expect(over.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  test("custom max is honoured (Pro = 60)", () => {
    const key = "pro-test"
    for (let i = 0; i < 60; i++) {
      const r = checkRateLimit(key, { max: 60 })
      expect(r.ok).toBe(true)
    }
    const over = checkRateLimit(key, { max: 60 })
    expect(over.ok).toBe(false)
  })

  test("free and pro buckets are independent even at the same source IP", () => {
    // Free bucket fills up ...
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit("free:1.2.3.4").ok).toBe(true)
    }
    expect(checkRateLimit("free:1.2.3.4").ok).toBe(false)
    // ... but the Pro bucket for the same origin is still empty.
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit("pro:sig123", { max: 60 }).ok).toBe(true)
    }
    expect(checkRateLimit("pro:sig123", { max: 60 }).ok).toBe(false)
  })

  test("different pro signatures get separate buckets", () => {
    for (let i = 0; i < 60; i++) expect(checkRateLimit("pro:A", { max: 60 }).ok).toBe(true)
    expect(checkRateLimit("pro:A", { max: 60 }).ok).toBe(false)
    // Sig B is unrelated.
    expect(checkRateLimit("pro:B", { max: 60 }).ok).toBe(true)
  })

  test("custom windowMs fits narrower bursts", () => {
    // 3 requests allowed in a 10-second window.
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit("narrow", { max: 3, windowMs: 10_000 }).ok).toBe(true)
    }
    expect(checkRateLimit("narrow", { max: 3, windowMs: 10_000 }).ok).toBe(false)
  })

  test("remaining counter decrements correctly on the last allowed call", () => {
    const first = checkRateLimit("ctr", { max: 2 })
    expect(first.ok).toBe(true)
    expect(first.remaining).toBe(1)
    const second = checkRateLimit("ctr", { max: 2 })
    expect(second.ok).toBe(true)
    expect(second.remaining).toBe(0)
  })
})
