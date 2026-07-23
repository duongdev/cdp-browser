import { describe, expect, it } from "vitest"
import { formatConversationLabel, formatName } from "./display-name"

describe("formatName", () => {
  it("full mode returns the name untouched", () => {
    expect(formatName("Careen Tan - Group Office", { mode: "full" })).toBe(
      "Careen Tan - Group Office",
    )
  })

  it("first mode strips the org suffix and keeps the first given name", () => {
    expect(formatName("Careen Tan - Group Office", { mode: "first" })).toBe("Careen")
    expect(formatName("Glory Nguyen - Group Office [C]", { mode: "first" })).toBe("Glory")
  })

  it("first mode on a plain name takes the first token", () => {
    expect(formatName("Bob Lee", { mode: "first" })).toBe("Bob")
    expect(formatName("Alice", { mode: "first" })).toBe("Alice")
  })

  it("regex mode strips matches and trims", () => {
    expect(formatName("Glory Nguyen - Group Office [C]", { mode: "regex", regex: " - .*$" })).toBe(
      "Glory Nguyen",
    )
  })

  it("an invalid or all-consuming regex falls back to the full name", () => {
    expect(formatName("Alice", { mode: "regex", regex: "[" })).toBe("Alice")
    expect(formatName("Alice", { mode: "regex", regex: ".*" })).toBe("Alice")
    expect(formatName("Alice", { mode: "regex" })).toBe("Alice")
  })

  it("empty input stays empty", () => {
    expect(formatName("", { mode: "first" })).toBe("")
  })
})

describe("formatConversationLabel", () => {
  it("transforms a 1:1 label but never a group/self label", () => {
    const pref = { mode: "first" as const }
    expect(formatConversationLabel("Careen Tan - Group Office", { kind: "oneOnOne" }, pref)).toBe(
      "Careen",
    )
    expect(formatConversationLabel("Careen, Glory, and Duong", { kind: "group" }, pref)).toBe(
      "Careen, Glory, and Duong",
    )
    expect(formatConversationLabel("Dustin (You)", { kind: "self" }, pref)).toBe("Dustin (You)")
  })
})
