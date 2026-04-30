import { test, expect } from "bun:test"
import { makeCsrfToken, verifyCsrfToken } from "../src/csrf"

test("CSRF token round-trips for matching session+secret", () => {
  const t = makeCsrfToken("sid_alice", "x".repeat(32))
  expect(verifyCsrfToken(t, "sid_alice", "x".repeat(32))).toBe(true)
})

test("CSRF token fails for wrong session", () => {
  const t = makeCsrfToken("sid_alice", "x".repeat(32))
  expect(verifyCsrfToken(t, "sid_bob", "x".repeat(32))).toBe(false)
})

test("CSRF token fails for wrong secret", () => {
  const t = makeCsrfToken("sid_alice", "x".repeat(32))
  expect(verifyCsrfToken(t, "sid_alice", "y".repeat(32))).toBe(false)
})

test("CSRF token fails for tampered length", () => {
  const t = makeCsrfToken("sid_alice", "x".repeat(32))
  expect(verifyCsrfToken(t + "AA", "sid_alice", "x".repeat(32))).toBe(false)
})
