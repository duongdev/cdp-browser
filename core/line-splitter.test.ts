import { describe, expect, it } from "vitest"
// CommonJS, shared with web/server.mjs — reassembles NDJSON frames from a chunked
// HTTP request-body stream (frames split across TCP chunks).
import { createLineSplitter } from "./line-splitter"

describe("line-splitter", () => {
  it("emits a complete line", () => {
    const s = createLineSplitter()
    expect(s.push("hello\n")).toEqual(["hello"])
  })

  it("buffers a partial line until its newline arrives", () => {
    const s = createLineSplitter()
    expect(s.push("ab")).toEqual([])
    expect(s.push("cd\n")).toEqual(["abcd"])
  })

  it("splits multiple lines in one chunk", () => {
    const s = createLineSplitter()
    expect(s.push("a\nb\nc\n")).toEqual(["a", "b", "c"])
  })

  it("handles a line split across chunks with a trailing partial", () => {
    const s = createLineSplitter()
    expect(s.push("x\ny")).toEqual(["x"])
    expect(s.push("\n")).toEqual(["y"])
  })

  it("skips blank lines (keepalive newlines)", () => {
    const s = createLineSplitter()
    expect(s.push("\n\na\n\n")).toEqual(["a"])
  })
})
