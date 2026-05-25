import { describe, expect, it } from "vitest"
import { createClosedStack } from "./closed-tabs"

describe("createClosedStack", () => {
  it("pops the most recently closed entry", () => {
    const s = createClosedStack()
    s.push({ kind: "cdp", url: "https://a.com" })
    expect(s.pop()).toEqual({ kind: "cdp", url: "https://a.com" })
  })

  it("pops in reverse close order regardless of kind", () => {
    const s = createClosedStack()
    s.push({ kind: "cdp", url: "https://a.com" })
    s.push({ kind: "local", url: "https://b.com" })
    s.push({ kind: "cdp", url: "https://c.com" })
    expect(s.pop()).toEqual({ kind: "cdp", url: "https://c.com" })
    expect(s.pop()).toEqual({ kind: "local", url: "https://b.com" })
    expect(s.pop()).toEqual({ kind: "cdp", url: "https://a.com" })
  })

  it("returns undefined when empty", () => {
    expect(createClosedStack().pop()).toBeUndefined()
  })
})
