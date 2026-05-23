import { describe, expect, it } from "vitest"
import { createClosedTabStack, nextTab, prevTab, reconcile, stripTitleBadge } from "./tabs"

describe("stripTitleBadge", () => {
  it("strips a leading unread count Teams prepends to the title", () => {
    expect(stripTitleBadge("(3) Chat | Microsoft Teams")).toBe("Chat | Microsoft Teams")
    expect(stripTitleBadge("(1) Outlook")).toBe("Outlook")
  })
  it("leaves a normal title untouched", () => {
    expect(stripTitleBadge("Chat | Microsoft Teams")).toBe("Chat | Microsoft Teams")
  })
  it("does not strip parenthetical text that isn't a leading count", () => {
    expect(stripTitleBadge("Meeting (notes) | Teams")).toBe("Meeting (notes) | Teams")
  })
})

const tab = (id: string, url = id) => ({ id, title: id, url, type: "page" })

describe("reconcile", () => {
  it("keeps the existing order and appends newly-seen tabs at the end", () => {
    // remote browser reports tabs in activity order; we ignore that and keep ours
    const order = ["a", "b"]
    const remote = [tab("c"), tab("b"), tab("a")]

    const result = reconcile(order, remote)

    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"])
  })

  it("drops tabs the Remote Browser no longer reports", () => {
    const result = reconcile(["a", "b", "c"], [tab("a"), tab("c")])
    expect(result.map((t) => t.id)).toEqual(["a", "c"])
  })
})

describe("nextTab / prevTab", () => {
  const tabs = [tab("a"), tab("b"), tab("c")]

  it("cycles forward and wraps past the end", () => {
    expect(nextTab(tabs, "a")).toBe("b")
    expect(nextTab(tabs, "c")).toBe("a")
  })

  it("cycles backward and wraps past the start", () => {
    expect(prevTab(tabs, "a")).toBe("c")
    expect(prevTab(tabs, "b")).toBe("a")
  })
})

describe("closed-tab stack", () => {
  it("pops the most recently closed url (LIFO)", () => {
    const stack = createClosedTabStack()
    stack.push("a.com")
    stack.push("b.com")

    expect(stack.popLast()).toBe("b.com")
    expect(stack.popLast()).toBe("a.com")
  })

  it("returns undefined when empty", () => {
    expect(createClosedTabStack().popLast()).toBeUndefined()
  })
})
