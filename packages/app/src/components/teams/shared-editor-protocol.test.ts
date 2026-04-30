import { describe, expect, test } from "bun:test"
import {
  SharedEditorProvider,
  encodeUpdate,
  decodeUpdate,
  type CrdtMessage,
  type CrdtTransport,
} from "./shared-editor-protocol"

/** Loopback transport — wires two provider instances directly together
 *  with no relay, so we can verify sync/awareness flow end-to-end. */
function makeLoopbackPair() {
  const aListeners = new Set<(m: CrdtMessage) => void>()
  const bListeners = new Set<(m: CrdtMessage) => void>()
  const aConnect = new Set<() => void>()
  const bConnect = new Set<() => void>()

  const a: CrdtTransport = {
    send(msg) {
      // a.send → delivered to b's listeners
      for (const cb of bListeners) cb(msg)
    },
    onMessage(cb) {
      aListeners.add(cb)
      return () => aListeners.delete(cb)
    },
    onConnect(cb) {
      aConnect.add(cb)
      return () => aConnect.delete(cb)
    },
  }
  const b: CrdtTransport = {
    send(msg) {
      for (const cb of aListeners) cb(msg)
    },
    onMessage(cb) {
      bListeners.add(cb)
      return () => bListeners.delete(cb)
    },
    onConnect(cb) {
      bConnect.add(cb)
      return () => bConnect.delete(cb)
    },
  }
  return {
    a,
    b,
    fireConnect() {
      for (const cb of aConnect) cb()
      for (const cb of bConnect) cb()
    },
  }
}

describe("SharedEditorProvider", () => {
  test("text typed on A appears on B (and vice versa)", () => {
    const { a, b, fireConnect } = makeLoopbackPair()
    const pa = new SharedEditorProvider({ docId: "doc1", transport: a })
    const pb = new SharedEditorProvider({ docId: "doc1", transport: b })
    fireConnect()

    pa.doc.getText("source").insert(0, "hello ")
    pb.doc.getText("source").insert(6, "world")

    expect(pa.doc.getText("source").toString()).toBe("hello world")
    expect(pb.doc.getText("source").toString()).toBe("hello world")
    pa.destroy()
    pb.destroy()
  })

  test("messages with mismatched doc_id are ignored", () => {
    const { a, b, fireConnect } = makeLoopbackPair()
    const pa = new SharedEditorProvider({ docId: "doc1", transport: a })
    const pb = new SharedEditorProvider({ docId: "doc2", transport: b })
    fireConnect()

    pa.doc.getText("source").insert(0, "from A")

    // pb is on doc2 — it must NOT receive doc1 updates.
    expect(pb.doc.getText("source").toString()).toBe("")
    pa.destroy()
    pb.destroy()
  })

  test("awareness state propagates user info", () => {
    const { a, b, fireConnect } = makeLoopbackPair()
    const pa = new SharedEditorProvider({
      docId: "doc1",
      transport: a,
      user: { name: "Alice", color: "#ff5722", customer_id: "cus_a" },
    })
    const pb = new SharedEditorProvider({ docId: "doc1", transport: b })
    fireConnect()

    // Force a state update so the awareness payload actually fires.
    pa.awareness.setLocalStateField("cursor", { line: 3, col: 7 })

    const states = Array.from(pb.awareness.getStates().values()) as Array<{
      user?: { name?: string }
      cursor?: { line: number; col: number }
    }>
    const aliceState = states.find((s) => s.user?.name === "Alice")
    expect(aliceState).toBeTruthy()
    expect(aliceState?.cursor?.line).toBe(3)

    pa.destroy()
    pb.destroy()
  })

  test("encodeUpdate / decodeUpdate roundtrip", () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128, 42])
    const decoded = decodeUpdate(encodeUpdate(original))
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })

  test("destroy is idempotent and stops broadcasting", () => {
    const { a, b, fireConnect } = makeLoopbackPair()
    const pa = new SharedEditorProvider({ docId: "doc1", transport: a })
    const pb = new SharedEditorProvider({ docId: "doc1", transport: b })
    fireConnect()

    pa.destroy()
    // Calling destroy a second time must not throw.
    pa.destroy()

    // After destroy, edits on pa's doc must not propagate to pb (transport
    // listener was unsubscribed and update handler removed).
    pa.doc.getText("source").insert(0, "ghost")
    expect(pb.doc.getText("source").toString()).toBe("")

    pb.destroy()
  })
})
