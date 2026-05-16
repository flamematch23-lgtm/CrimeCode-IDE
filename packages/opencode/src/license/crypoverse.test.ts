/**
 * Unit tests for the Crypoverse adapter.
 *
 * Network calls (initiate, SSE) are not exercised — those need a live
 * gateway and an API key, and the bot's existing payment flow is a much
 * better integration test. What we do cover here are the pure helpers:
 * SSE wire parsing and terminal-status classification, which is where the
 * tricky string-matching logic lives.
 */
import { describe, expect, test } from "bun:test"
import { __test } from "./crypoverse"

describe("crypoverse terminal status classification", () => {
  test("isTerminalPaid matches the documented + common variants", () => {
    expect(__test.isTerminalPaid("paid")).toBe(true)
    expect(__test.isTerminalPaid("PAID")).toBe(true)
    expect(__test.isTerminalPaid("Paid")).toBe(true)
    expect(__test.isTerminalPaid("confirmed")).toBe(true)
    expect(__test.isTerminalPaid("completed")).toBe(true)
    expect(__test.isTerminalPaid("succeeded")).toBe(true)
    // Substring match — gateway sometimes emits richer labels.
    expect(__test.isTerminalPaid("payment_paid_in_full")).toBe(true)
  })

  test("isTerminalPaid does NOT match in-progress states", () => {
    expect(__test.isTerminalPaid("initiated")).toBe(false)
    expect(__test.isTerminalPaid("pending")).toBe(false)
    expect(__test.isTerminalPaid("awaiting_confirmation")).toBe(false)
    expect(__test.isTerminalPaid("")).toBe(false)
    expect(__test.isTerminalPaid("unknown")).toBe(false)
  })

  test("isTerminalFailed matches failure variants", () => {
    expect(__test.isTerminalFailed("expired")).toBe(true)
    expect(__test.isTerminalFailed("cancelled")).toBe(true)
    expect(__test.isTerminalFailed("canceled")).toBe(true) // US spelling
    expect(__test.isTerminalFailed("failed")).toBe(true)
    expect(__test.isTerminalFailed("refunded")).toBe(true)
    expect(__test.isTerminalFailed("INVOICE_EXPIRED")).toBe(true)
  })

  test("paid and failed are mutually exclusive", () => {
    for (const s of ["paid", "confirmed", "completed", "succeeded"]) {
      expect(__test.isTerminalPaid(s)).toBe(true)
      expect(__test.isTerminalFailed(s)).toBe(false)
    }
    for (const s of ["expired", "cancelled", "failed", "refunded"]) {
      expect(__test.isTerminalPaid(s)).toBe(false)
      expect(__test.isTerminalFailed(s)).toBe(true)
    }
  })
})

describe("crypoverse SSE wire parsing", () => {
  test("extractDataField pulls single-line data", () => {
    const raw = `event: status\ndata: {"id":"abc","status":"paid"}\nid: 1`
    expect(__test.extractDataField(raw)).toBe('{"id":"abc","status":"paid"}')
  })

  test("extractDataField concatenates multi-line data per SSE spec", () => {
    // Per https://html.spec.whatwg.org/multipage/server-sent-events.html,
    // multiple `data:` lines in one event are joined with newlines.
    const raw = `data: line1\ndata: line2\ndata: line3`
    expect(__test.extractDataField(raw)).toBe("line1\nline2\nline3")
  })

  test("extractDataField returns null when no data field present", () => {
    expect(__test.extractDataField("event: heartbeat\nid: 42")).toBeNull()
    expect(__test.extractDataField("")).toBeNull()
    expect(__test.extractDataField(": just a comment")).toBeNull()
  })

  test("extractDataField tolerates leading whitespace after colon", () => {
    expect(__test.extractDataField("data:no-space")).toBe("no-space")
    expect(__test.extractDataField("data: one-space")).toBe("one-space")
    expect(__test.extractDataField("data:   three-spaces")).toBe("three-spaces")
  })

  test("extractDataField handles CRLF line endings", () => {
    const raw = "event: status\r\ndata: {\"status\":\"paid\"}\r\nid: 99"
    expect(__test.extractDataField(raw)).toBe('{"status":"paid"}')
  })
})
