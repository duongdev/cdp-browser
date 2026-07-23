import { describe, expect, it } from "vitest"
// Pure DM/group-DM name helpers (t131, ADR-0019). No CDP, no network — the effectful roster +
// Graph resolution lives in web/server.mjs; these are the id parsers + title composer.
import { composeTitle, normalizeUserOid, oidFromMri, otherMrisFromId } from "./teams-names"

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

describe("normalizeUserOid", () => {
  const UUID = "623d9d09-8883-43fc-a957-17a73b5ee4f3"
  it("accepts a bare uuid", () => {
    expect(normalizeUserOid(UUID)).toBe(UUID)
  })
  it("strips the 8:orgid: prefix and accepts the uuid", () => {
    expect(normalizeUserOid(`8:orgid:${UUID}`)).toBe(UUID)
  })
  it("rejects a non-uuid / url / garbage (SSRF guard)", () => {
    expect(normalizeUserOid("https://evil.com/x")).toBe("")
    expect(normalizeUserOid("../../etc/passwd")).toBe("")
    expect(normalizeUserOid("48:notes")).toBe("")
    expect(normalizeUserOid("")).toBe("")
    expect(normalizeUserOid(null)).toBe("")
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

  // Teams "Notes" (chat-with-yourself, id 48:notes). Title = "{selfName} (You)".
  it("self chat → '{selfName} (You)', or 'Notes' with no name", () => {
    expect(composeTitle({ kind: "self", selfName: "Dustin Do - Group Office [C]" })).toBe(
      "Dustin Do - Group Office [C] (You)",
    )
    expect(composeTitle({ kind: "self" })).toBe("Notes")
    expect(composeTitle({ kind: "self", selfName: "   " })).toBe("Notes")
  })

  it("DM → the one other full name (unchanged)", () => {
    expect(composeTitle({ kind: "oneOnOne", topic: null, memberNames: ["Alice Nguyen"] })).toBe(
      "Alice Nguyen",
    )
  })

  // Group-DM without a topic = given names (first token), self excluded, alpha-sorted, joined by
  // member count — matching Teams verbatim.
  it("group-DM → given names, alpha-sorted, joined by count", () => {
    // n=1 → just the given name
    expect(
      composeTitle({ kind: "group", topic: null, memberNames: ["Careen Tan - Group Office"] }),
    ).toBe("Careen")
    // n=2 → "A and B"
    expect(
      composeTitle({ kind: "group", topic: null, memberNames: ["Tiffani Wong", "Careen Tan"] }),
    ).toBe("Careen and Tiffani")
    // n=3 → Oxford comma + "and"
    expect(
      composeTitle({
        kind: "group",
        topic: null,
        memberNames: ["Haiyang Li", "Careen Tan", "Glory Sun"],
      }),
    ).toBe("Careen, Glory, and Haiyang")
  })

  it("group-DM ≥4 → first two given names alpha + '+N' overflow", () => {
    expect(
      composeTitle({
        kind: "group",
        topic: null,
        memberNames: ["Haiyang Li", "Careen Tan", "Zed Xu", "Ana Bo"],
      }),
    ).toBe("Ana, Careen, +2")
  })

  it("keeps duplicate given names (two different people, same first name)", () => {
    expect(composeTitle({ kind: "group", topic: null, memberNames: ["Alex Kim", "Alex Ng"] })).toBe(
      "Alex and Alex",
    )
  })

  it("excludes selfName from the names", () => {
    expect(
      composeTitle({
        kind: "group",
        topic: null,
        memberNames: ["Me Myself", "Bob Jones"],
        selfName: "Me Myself",
      }),
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
