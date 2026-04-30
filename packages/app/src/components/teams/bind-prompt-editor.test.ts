/**
 * Tests for the minimal-diff strategy in bindPromptEditor's onInput. We
 * exercise the diff against a Y.Doc directly (no DOM) so we can simulate
 * what would happen if Alice and Bob type at the same time.
 *
 * The key invariant: a single onInput must not blow away peer edits. The
 * pre-fix code did `delete(0, len); insert(0, text)` which loses any
 * concurrent changes from another peer. The fix shrinks the range to the
 * minimal common-prefix / common-suffix delta.
 */
import { describe, expect, it } from "bun:test"
import * as Y from "yjs"

// We re-implement the diff inline because the production version lives
// inside a closure (LOCAL Symbol origin captured at bind time). Both
// implementations are line-for-line identical and stay in sync.
function applyMinimalDiff(ytext: Y.Text, newText: string, origin: unknown): void {
  const oldText = ytext.toString()
  if (oldText === newText) return
  let prefix = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++
  let suffix = 0
  const maxSuffix = minLen - prefix
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  )
    suffix++
  const deleteLen = oldText.length - prefix - suffix
  const insertText = newText.slice(prefix, newText.length - suffix)
  if (deleteLen === 0 && insertText.length === 0) return
  ytext.doc!.transact(() => {
    if (deleteLen > 0) ytext.delete(prefix, deleteLen)
    if (insertText) ytext.insert(prefix, insertText)
  }, origin)
}

describe("bindPromptEditor diff", () => {
  it("inserts a single character at the end", () => {
    const doc = new Y.Doc()
    const t = doc.getText("draft")
    t.insert(0, "hello")
    applyMinimalDiff(t, "hello!", "local")
    expect(t.toString()).toBe("hello!")
  })

  it("deletes a single character at the end", () => {
    const doc = new Y.Doc()
    const t = doc.getText("draft")
    t.insert(0, "hello!")
    applyMinimalDiff(t, "hello", "local")
    expect(t.toString()).toBe("hello")
  })

  it("replaces a middle range only", () => {
    const doc = new Y.Doc()
    const t = doc.getText("draft")
    t.insert(0, "the quick brown fox")
    applyMinimalDiff(t, "the quick red fox", "local")
    expect(t.toString()).toBe("the quick red fox")
  })

  it("preserves a concurrent peer insert at the end", () => {
    // Alice and Bob start from the same state. Alice types " world" at the
    // end; Bob types "!" at the end SIMULTANEOUSLY. After merging, the doc
    // should contain BOTH edits (in some order), never either lost.
    const alice = new Y.Doc()
    const bob = new Y.Doc()
    const aliceText = alice.getText("draft")
    const bobText = bob.getText("draft")
    aliceText.insert(0, "hello")
    // Sync Bob with Alice's initial state.
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    expect(bobText.toString()).toBe("hello")

    // Alice types " world" (her DOM input fires "hello world"):
    applyMinimalDiff(aliceText, "hello world", "alice")
    // Bob types "!" (his DOM input fires "hello!"):
    applyMinimalDiff(bobText, "hello!", "bob")

    // Sync both ways.
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob))

    // Both edits should be preserved. The merged text contains all three:
    // the original "hello" + Alice's " world" + Bob's "!". The CRDT picks
    // one ordering — both clients converge on the same one.
    const merged = aliceText.toString()
    expect(bobText.toString()).toBe(merged)
    expect(merged).toContain("hello")
    expect(merged).toContain(" world")
    expect(merged).toContain("!")
  })

  it("is a no-op when text is unchanged", () => {
    const doc = new Y.Doc()
    const t = doc.getText("draft")
    t.insert(0, "stable")
    let updates = 0
    doc.on("update", () => updates++)
    applyMinimalDiff(t, "stable", "local")
    expect(updates).toBe(0)
  })

  it("handles complete clear", () => {
    const doc = new Y.Doc()
    const t = doc.getText("draft")
    t.insert(0, "byebye")
    applyMinimalDiff(t, "", "local")
    expect(t.toString()).toBe("")
  })

  it("handles insert into empty doc", () => {
    const doc = new Y.Doc()
    const t = doc.getText("draft")
    applyMinimalDiff(t, "first!", "local")
    expect(t.toString()).toBe("first!")
  })
})
