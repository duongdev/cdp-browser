import { describe, expect, it } from "vitest"
// Pure DM/group-DM name helpers (t109, ADR-0018). No CDP, no network — the effectful roster +
// Graph resolution lives in web/server.mjs; these are the id parsers + title composer.
import { composeTitle, oidFromMri, otherMrisFromId } from "./teams-names"

const SELF = "8:orgid:AAA"
const OTHER = "8:orgid:BBB"

describe("otherMrisFromId", () => {
  it("derives the other member's MRI from a 1:1 id (no fetch)", () => {
    const id = `19:${SELF}_${OTHER}@unq.gbl.spaces`
    expect(otherMrisFromId(id, SELF)).toEqual([OTHER])
  })

  it("drops self regardless of order", () => {
    const id = `19:${OTHER}_${SELF}@unq.gbl.spaces`
    expect(otherMrisFromId(id, SELF)).toEqual([OTHER])
  })

  // Live Teams uses BARE oids in the 1:1 id (not 8:orgid: MRIs) while selfMri is 8:orgid:{oid};
  // self must still be dropped via oid normalization, in either id order.
  it("drops self from a real bare-oid 1:1 id (either order)", () => {
    const self = "8:orgid:AAA"
    expect(otherMrisFromId("19:AAA_BBB@unq.gbl.spaces", self)).toEqual(["BBB"])
    expect(otherMrisFromId("19:BBB_AAA@unq.gbl.spaces", self)).toEqual(["BBB"])
  })

  it("returns [] for a group-DM id (roster comes from the members fetch)", () => {
    expect(otherMrisFromId("19:xyz@thread.v2", SELF)).toEqual([])
  })

  it("is defensive on garbage input", () => {
    expect(otherMrisFromId(null, SELF)).toEqual([])
    expect(otherMrisFromId(undefined, SELF)).toEqual([])
    expect(otherMrisFromId("", SELF)).toEqual([])
  })

  it("returns both when self is absent (best effort)", () => {
    const id = `19:${SELF}_${OTHER}@unq.gbl.spaces`
    expect(otherMrisFromId(id, "8:orgid:ZZZ")).toEqual([SELF, OTHER])
  })
})

describe("oidFromMri", () => {
  it("strips the 8:orgid: prefix", () => {
    expect(oidFromMri("8:orgid:AAA")).toBe("AAA")
  })

  it("returns the input when it has no prefix, and '' for non-strings", () => {
    expect(oidFromMri("AAA")).toBe("AAA")
    expect(oidFromMri(null)).toBe("")
  })
})

describe("composeTitle", () => {
  it("uses the topic when set (any kind)", () => {
    expect(composeTitle({ kind: "group", topic: "Design sync", memberNames: [] })).toBe(
      "Design sync",
    )
    expect(composeTitle({ kind: "oneOnOne", topic: "  Spaced  ", memberNames: ["X"] })).toBe(
      "Spaced",
    )
  })

  it("DM → the one other name", () => {
    expect(composeTitle({ kind: "oneOnOne", topic: null, memberNames: ["Alice"] })).toBe("Alice")
  })

  it("group-DM → comma-joined names under the cap", () => {
    expect(composeTitle({ kind: "group", topic: null, memberNames: ["Alice", "Bob"] })).toBe(
      "Alice, Bob",
    )
    expect(
      composeTitle({ kind: "group", topic: null, memberNames: ["Alice", "Bob", "Cara"] }),
    ).toBe("Alice, Bob, Cara")
  })

  it("group-DM → caps names and adds a +N overflow", () => {
    expect(
      composeTitle({ kind: "group", topic: null, memberNames: ["Alice", "Bob", "Cara", "Dan"] }),
    ).toBe("Alice, Bob, Cara, +1")
    expect(
      composeTitle({
        kind: "group",
        topic: null,
        memberNames: ["Alice", "Bob", "Cara", "Dan", "Eve"],
      }),
    ).toBe("Alice, Bob, Cara, +2")
  })

  it("excludes selfName from the names", () => {
    expect(
      composeTitle({ kind: "group", topic: null, memberNames: ["Me", "Bob"], selfName: "Me" }),
    ).toBe("Bob")
  })

  it("falls back by kind when no names resolve", () => {
    expect(composeTitle({ kind: "oneOnOne", topic: null, memberNames: [] })).toBe("Direct message")
    expect(composeTitle({ kind: "group", topic: null, memberNames: [] })).toBe("Group chat")
    expect(composeTitle({ kind: "group", topic: null, memberNames: ["  ", ""] })).toBe("Group chat")
  })

  it("never crashes on missing input", () => {
    expect(composeTitle()).toBe("Group chat")
    expect(composeTitle({ kind: "oneOnOne" })).toBe("Direct message")
  })
})
