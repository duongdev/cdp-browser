import { describe, expect, it } from "vitest"
import { type ActiveRef, dropActive, mostRecent, touchActive } from "./active-order"

const cdp = (id: string): ActiveRef => ({ kind: "cdp", id })
const local = (id: string): ActiveRef => ({ kind: "local", id })

describe("touchActive", () => {
  it("appends a new activation as most-recent", () => {
    expect(touchActive([cdp("a")], cdp("b"))).toEqual([cdp("a"), cdp("b")])
  })

  it("moves an existing activation to most-recent without duplicating", () => {
    expect(touchActive([cdp("a"), cdp("b"), cdp("c")], cdp("a"))).toEqual([
      cdp("b"),
      cdp("c"),
      cdp("a"),
    ])
  })

  it("keys by kind+id, so a CDP and local tab with the same id are distinct", () => {
    expect(touchActive([cdp("x")], local("x"))).toEqual([cdp("x"), local("x")])
  })
})

describe("dropActive", () => {
  it("removes the matching kind+id only", () => {
    expect(dropActive([cdp("a"), local("a"), cdp("b")], cdp("a"))).toEqual([local("a"), cdp("b")])
  })
})

describe("mostRecent", () => {
  it("returns the newest entry that is still open", () => {
    const order = [cdp("a"), local("b"), cdp("c")]
    const open = new Set(["cdp:a", "local:b"])
    expect(mostRecent(order, (e) => open.has(`${e.kind}:${e.id}`))).toEqual(local("b"))
  })

  it("returns undefined when nothing is open", () => {
    expect(mostRecent([cdp("a")], () => false)).toBeUndefined()
  })
})
