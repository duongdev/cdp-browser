import { describe, expect, it } from "vitest"
import { avatarGradient, avatarInitials, realName } from "./avatar-style"

describe("realName", () => {
  it("keeps only the part before ' - ' (person, not org)", () => {
    expect(realName("Forbes Elyser - Group Office [C]")).toBe("Forbes Elyser")
    expect(realName("Bhanu - Group Office")).toBe("Bhanu")
  })
  it("strips [tags] and (you)", () => {
    expect(realName("Dustin Do - Group Office [C] (You)")).toBe("Dustin Do")
    expect(realName("[TG] GenAI knowledge sharing session")).toBe("GenAI knowledge sharing session")
  })
  it("falls back to the cleaned full string when stripping empties it", () => {
    expect(realName("[TG]")).toBe("[TG]")
  })
})

describe("avatarInitials", () => {
  it("takes the first two words of the real name", () => {
    expect(avatarInitials("Forbes Elyser - Group Office [C]")).toBe("FE")
    expect(avatarInitials("Ethan Nguyen - Group Office [C]")).toBe("EN")
    expect(avatarInitials("Dustin Do - Group Office [C] (You)")).toBe("DD")
    expect(avatarInitials("[TG] GenAI knowledge sharing session")).toBe("GK")
    expect(avatarInitials("Trainer Lego Architecture, Tech Stack")).toBe("TL")
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

  it("handles emoji/non-latin gracefully", () => {
    expect(avatarInitials("😀 World").length).toBeGreaterThan(0)
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
