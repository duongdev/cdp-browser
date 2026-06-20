import { describe, expect, it } from "vitest"
import { CLOSED_STACK_CAP, createClosedStack } from "./closed-tabs"

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

  it("drops the oldest entry when the cap is exceeded", () => {
    const s = createClosedStack(2)
    s.push({ kind: "cdp", url: "https://a.com" })
    s.push({ kind: "cdp", url: "https://b.com" })
    s.push({ kind: "cdp", url: "https://c.com" })

    expect(s.pop()).toEqual({ kind: "cdp", url: "https://c.com" })
    expect(s.pop()).toEqual({ kind: "cdp", url: "https://b.com" })
    expect(s.pop()).toBeUndefined()
  })

  it("keeps only the most recent entries up to the default cap", () => {
    const s = createClosedStack()
    for (let i = 0; i < CLOSED_STACK_CAP + 10; i++) {
      s.push({ kind: "cdp", url: `https://x${i}.com` })
    }

    let survivors = 0
    while (s.pop()) survivors++

    expect(survivors).toBe(CLOSED_STACK_CAP)
  })
})
