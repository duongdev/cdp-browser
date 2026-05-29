import { describe, expect, it } from "vitest"
import type { ActiveRef } from "./active-order"
import type { LocalTab } from "./local-tabs"
import { type CloseInput, planClose, planSwitch } from "./tab-lifecycle"

const cdp = (id: string): ActiveRef => ({ kind: "cdp", id })
const local = (id: string): ActiveRef => ({ kind: "local", id })

const localTab = (id: string, over: Partial<LocalTab> = {}): LocalTab => ({
  id,
  url: `https://${id}.local`,
  title: id,
  pinned: false,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  ...over,
})

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: "p1",
  title: "Pinned",
  url: "https://pin.example",
  ...over,
})

// A close where `a` (CDP) is the active tab. `b` (CDP) was active before it.
const baseCdpClose = (over: Partial<CloseInput> = {}): CloseInput => ({
  kind: "cdp",
  id: "a",
  url: "https://a.com",
  wasActive: true,
  // oldest → newest; `a` is most-recent (active), `b` before it.
  order: [cdp("b"), cdp("a")],
  tabs: [{ id: "b", url: "https://b.com" }],
  locals: [],
  pins: [],
  ...over,
})

describe("planClose — next active selection", () => {
  it("closing the active CDP tab falls back to the MRU still-open CDP sibling", () => {
    const d = planClose(baseCdpClose())
    expect(d.nextActive).toEqual(cdp("b"))
    expect(d.clearActive).toBe(false)
  })

  it("crosses kinds to a Local Tab when it is the only other open surface", () => {
    const d = planClose(
      baseCdpClose({
        order: [local("L1"), cdp("a")],
        tabs: [],
        locals: [localTab("L1")],
      }),
    )
    expect(d.nextActive).toEqual(local("L1"))
  })

  it("falls back to the first visible CDP tab when Active Order is exhausted", () => {
    const d = planClose(
      baseCdpClose({
        // order only knew about `a` (now closed); no other history.
        order: [cdp("a")],
        tabs: [
          { id: "c", url: "https://c.com" },
          { id: "b", url: "https://b.com" },
        ],
      }),
    )
    expect(d.nextActive).toEqual(cdp("c"))
  })

  it("falls back to the first Local Tab when no CDP tab is visible and order is exhausted", () => {
    const d = planClose(
      baseCdpClose({
        order: [cdp("a")],
        tabs: [],
        locals: [localTab("L2"), localTab("L3")],
      }),
    )
    expect(d.nextActive).toEqual(local("L2"))
  })

  it("clears the active surface when nothing remains open", () => {
    const d = planClose(
      baseCdpClose({
        order: [cdp("a")],
        tabs: [],
        locals: [],
      }),
    )
    expect(d.nextActive).toBeNull()
    expect(d.clearActive).toBe(true)
  })

  it("leaves the active surface alone when a non-active tab closes", () => {
    const d = planClose(
      baseCdpClose({
        id: "b",
        url: "https://b.com",
        wasActive: false,
        order: [cdp("b"), cdp("a")],
        tabs: [{ id: "a", url: "https://a.com" }],
      }),
    )
    expect(d.nextActive).toBeNull()
    expect(d.clearActive).toBe(false)
  })
})

describe("planClose — local tab closures", () => {
  it("falls back to the MRU still-open surface across kinds", () => {
    const d = planClose({
      kind: "local",
      id: "L1",
      url: "https://l1.local",
      wasActive: true,
      order: [cdp("a"), local("L1")],
      tabs: [{ id: "a", url: "https://a.com" }],
      locals: [],
      pins: [],
    })
    expect(d.nextActive).toEqual(cdp("a"))
  })

  it("falls back to the first remaining Local Tab when order is exhausted", () => {
    const d = planClose({
      kind: "local",
      id: "L1",
      url: "https://l1.local",
      wasActive: true,
      order: [local("L1")],
      tabs: [],
      locals: [localTab("L2")],
      pins: [],
    })
    expect(d.nextActive).toEqual(local("L2"))
  })

  it("clears when the last Local Tab closes and nothing else is open", () => {
    const d = planClose({
      kind: "local",
      id: "L1",
      url: "https://l1.local",
      wasActive: true,
      order: [local("L1")],
      tabs: [],
      locals: [],
      pins: [],
    })
    expect(d.nextActive).toBeNull()
    expect(d.clearActive).toBe(true)
  })
})

describe("planClose — closedEntry", () => {
  it("carries the closed CDP tab's kind and url", () => {
    const d = planClose(baseCdpClose())
    expect(d.closedEntry).toEqual({ kind: "cdp", url: "https://a.com" })
  })

  it("carries the closed Local Tab's kind and url", () => {
    const d = planClose({
      kind: "local",
      id: "L1",
      url: "https://l1.local",
      wasActive: false,
      order: [],
      tabs: [],
      locals: [localTab("L2")],
      pins: [],
    })
    expect(d.closedEntry).toEqual({ kind: "local", url: "https://l1.local" })
  })
})

describe("planClose — pin revert", () => {
  it("reports the pin revert when the closed CDP tab was held by a pin", () => {
    const held = pin({ id: "p1", targetId: "a" })
    const d = planClose(baseCdpClose({ pins: [held] }))
    expect(d.revertPin).toEqual(held)
  })

  it("does not report a pin revert for an unlinked tab", () => {
    const d = planClose(baseCdpClose({ pins: [pin({ id: "p1", targetId: "z" })] }))
    expect(d.revertPin).toBeUndefined()
  })

  it("never reports a pin revert for a Local Tab closure", () => {
    const d = planClose({
      kind: "local",
      id: "a",
      url: "https://a.com",
      wasActive: false,
      order: [],
      tabs: [],
      locals: [],
      pins: [pin({ id: "p1", targetId: "a" })],
    })
    expect(d.revertPin).toBeUndefined()
  })
})

describe("planClose — purity", () => {
  it("does not mutate the input order, tabs, locals, or pins arrays", () => {
    const order = [cdp("b"), cdp("a")]
    const tabs = [{ id: "b", url: "https://b.com" }]
    const locals = [localTab("L1")]
    const pins = [pin({ id: "p1", targetId: "a" })]
    const orderCopy = [...order]
    const tabsCopy = [...tabs]
    const localsCopy = [...locals]
    const pinsCopy = [...pins]

    planClose({
      kind: "cdp",
      id: "a",
      url: "https://a.com",
      wasActive: true,
      order,
      tabs,
      locals,
      pins,
    })

    expect(order).toEqual(orderCopy)
    expect(tabs).toEqual(tabsCopy)
    expect(locals).toEqual(localsCopy)
    expect(pins).toEqual(pinsCopy)
  })
})

describe("planSwitch", () => {
  it("moves an existing ActiveRef to most-recent", () => {
    expect(planSwitch([cdp("a"), cdp("b")], cdp("a"))).toEqual([cdp("b"), cdp("a")])
  })

  it("appends a fresh ActiveRef as most-recent", () => {
    expect(planSwitch([cdp("a")], local("L1"))).toEqual([cdp("a"), local("L1")])
  })

  it("does not mutate the input order", () => {
    const order = [cdp("a"), cdp("b")]
    const copy = [...order]
    planSwitch(order, cdp("a"))
    expect(order).toEqual(copy)
  })
})
