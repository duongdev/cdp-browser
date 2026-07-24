import { describe, expect, it } from "vitest"
import { avatarGradient, avatarInitials } from "./avatar-style"

describe("avatarInitials", () => {
  it("returns first+last initials for 'Firstname Lastname'", () => {
    expect(avatarInitials("Alice Smith")).toBe("AS")
  })

  it("uses first and last word for 3+ word names", () => {
    expect(avatarInitials("Mary Jane Watson")).toBe("MW")
  })

  it("returns first 2 letters for a single word", () => {
    expect(avatarInitials("Alice")).toBe("AL")
  })

  it("handles a single character name", () => {
    expect(avatarInitials("Z")).toBe("Z")
  })

  it("returns ? for empty / whitespace only", () => {
    expect(avatarInitials("")).toBe("?")
    expect(avatarInitials("   ")).toBe("?")
  })

  it("handles comma-separated names (facepile labels)", () => {
    expect(avatarInitials("Alice, Bob")).toBe("AB")
  })

  it("uppercases the result", () => {
    expect(avatarInitials("alice smith")).toBe("AS")
  })

  it("handles emoji/non-latin gracefully (returns first code point)", () => {
    const result = avatarInitials("😀 World")
    // First word starts with emoji, last word starts with 'W'
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("avatarGradient", () => {
  it("is deterministic — same seed → same result", () => {
    expect(avatarGradient("abc123")).toBe(avatarGradient("abc123"))
  })

  it("returns a CSS linear-gradient string", () => {
    expect(avatarGradient("user1")).toMatch(/^linear-gradient\(135deg,/)
  })

  it("different seeds produce different gradients", () => {
    const results = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(avatarGradient))
    expect(results.size).toBeGreaterThan(3)
  })

  it("handles empty seed without throwing", () => {
    expect(() => avatarGradient("")).not.toThrow()
  })

  it("from and to colors differ (offset ensures variety)", () => {
    const g = avatarGradient("test-seed")
    // Extract the two hsl(...) values
    const matches = g.match(/hsl\([^)]+\)/g)
    expect(matches).toHaveLength(2)
    expect(matches?.[0]).not.toBe(matches?.[1])
  })
})
