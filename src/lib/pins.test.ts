import { describe, expect, it } from "vitest"
import { dropDeadLinks, pinForTarget, resolvePinLink } from "./pins"

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: "p1",
  title: "Gmail",
  url: "https://mail.google.com/",
  ...over,
})

const target = (id: string, url: string) => ({ id, url })

describe("resolvePinLink", () => {
  it("keeps the persisted target when it is still alive", () => {
    const targets = [target("t1", "https://example.com/"), target("t2", "https://mail.google.com/")]
    expect(resolvePinLink(pin({ targetId: "t1" }), targets)).toBe("t1")
  })

  it("falls back to a url match when the persisted target is gone", () => {
    const targets = [target("t9", "https://mail.google.com/")]
    expect(resolvePinLink(pin({ targetId: "dead" }), targets)).toBe("t9")
  })

  it("returns undefined when neither id nor url matches", () => {
    const targets = [target("t1", "https://example.com/")]
    expect(resolvePinLink(pin({ targetId: "dead" }), targets)).toBeUndefined()
  })
})

describe("pinForTarget", () => {
  it("finds the pin that owns a target id", () => {
    const pins = [pin({ id: "p1", targetId: "t1" }), pin({ id: "p2", targetId: "t2" })]
    expect(pinForTarget(pins, "t2")?.id).toBe("p2")
  })

  it("returns undefined when no pin owns the target", () => {
    const pins = [pin({ id: "p1", targetId: "t1" })]
    expect(pinForTarget(pins, "t9")).toBeUndefined()
  })
})

describe("dropDeadLinks", () => {
  it("clears targetId for pins whose target is gone", () => {
    const pins = [pin({ id: "p1", targetId: "t1" }), pin({ id: "p2", targetId: "dead" })]
    const result = dropDeadLinks(pins, [target("t1", "x")])
    expect(result.find((p) => p.id === "p1")?.targetId).toBe("t1")
    expect(result.find((p) => p.id === "p2")?.targetId).toBeUndefined()
  })

  it("returns the same array reference when nothing changed", () => {
    const pins = [pin({ id: "p1", targetId: "t1" })]
    expect(dropDeadLinks(pins, [target("t1", "x")])).toBe(pins)
  })
})
