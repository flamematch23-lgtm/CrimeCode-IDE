import { describe, expect, it } from "bun:test"
import { parseChatBody } from "./chat-message-body"

describe("parseChatBody", () => {
  it("returns a single text block when there are no code fences", () => {
    const out = parseChatBody("Hello world\nciao")
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: "text", content: "Hello world\nciao" })
  })

  it("parses a single fenced code block with a language", () => {
    const out = parseChatBody("Run this:\n```python\nprint(1)\n```\ndone")
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ kind: "text", content: "Run this:\n" })
    expect(out[1]).toEqual({ kind: "code", language: "python", content: "print(1)\n" })
    expect(out[2]).toEqual({ kind: "text", content: "\ndone" })
  })

  it("falls back to language='text' when the fence has no language tag", () => {
    const out = parseChatBody("```\nls -la\n```")
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("code")
    expect(out[0].language).toBe("text")
    expect(out[0].content).toBe("ls -la\n")
  })

  it("handles multiple fenced blocks", () => {
    const out = parseChatBody("a\n```js\n1\n```\nb\n```ts\n2\n```\nc")
    expect(out.map((b) => b.kind)).toEqual(["text", "code", "text", "code", "text"])
    expect(out[1]).toMatchObject({ language: "js", content: "1\n" })
    expect(out[3]).toMatchObject({ language: "ts", content: "2\n" })
  })

  it("ignores unbalanced fences (graceful degradation to text)", () => {
    // Single fence with no closing — leave as text rather than swallowing the message.
    const out = parseChatBody("hello\n```bash\nrm -rf /\n(no close)")
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("text")
  })

  it("preserves leading and trailing whitespace inside code", () => {
    const out = parseChatBody("```\n  hi  \n```")
    expect(out[0]).toMatchObject({ kind: "code", content: "  hi  \n" })
  })

  it("returns empty array for an empty string", () => {
    expect(parseChatBody("")).toEqual([])
  })
})
