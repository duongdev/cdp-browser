import { describe, expect, it } from "vitest"
// @ts-expect-error — CJS core module, no types (backend-shared, run under vitest only)
import { DEFAULT_REACTIONS, emojiToKey, reactionEmoji } from "./teams-emoji"

describe("reactionEmoji", () => {
  it("maps the six default Teams emotion keys", () => {
    expect(reactionEmoji("like")).toBe("👍")
    expect(reactionEmoji("heart")).toBe("❤️")
    expect(reactionEmoji("laugh")).toBe("😆")
    expect(reactionEmoji("surprised")).toBe("😮")
    expect(reactionEmoji("sad")).toBe("😢")
    expect(reactionEmoji("angry")).toBe("😠")
  })

  it("maps common extended keys", () => {
    expect(reactionEmoji("loudlycrying")).toBe("😭")
    expect(reactionEmoji("heart_eyes")).toBe("😍")
  })

  it("returns a neutral fallback for an unknown key (never the raw key)", () => {
    expect(reactionEmoji("some_new_emotion")).toBe("🙂")
    expect(reactionEmoji("")).toBe("🙂")
  })

  it("resolves a skin-tone thumbs-up to 👍 (the reported 🙂 bug)", () => {
    expect(reactionEmoji("yes")).toBe("👍")
    expect(reactionEmoji("yes-tone1")).toBe("👍")
    expect(reactionEmoji("yes-tone5")).toBe("👍")
    expect(reactionEmoji("praying-tone1")).toBe("🙏")
  })

  it("derives the glyph from a unicode-codepoint-prefixed key", () => {
    expect(reactionEmoji("1f4af_hundredpointssymbol")).toBe("💯")
    expect(reactionEmoji("1f440_eyes")).toBe("👀")
    expect(reactionEmoji("2705_whiteheavycheckmark")).toBe("✅")
  })

  it("falls back for an unknown custom org emoji (name;objectId)", () => {
    expect(reactionEmoji("hajimi_run;0-ea-d11-abc")).toBe("🙂")
  })
})

describe("emojiToKey", () => {
  it("returns the canonical named key for the 6 defaults (round-trip)", () => {
    expect(emojiToKey("👍")).toBe("like")
    expect(emojiToKey("❤️")).toBe("heart")
    expect(emojiToKey("😆")).toBe("laugh")
    expect(emojiToKey("😮")).toBe("surprised")
    expect(emojiToKey("😢")).toBe("sad")
    expect(emojiToKey("😠")).toBe("angry")
  })

  it("round-trips via reactionEmoji for codepoint-encoded glyphs", () => {
    // Single-codepoint: 💯 (U+1F4AF) → "1f4af_e" (suffix ensures the decoder's regex fires)
    const key100 = emojiToKey("💯")
    expect(key100).toBe("1f4af_e")
    expect(reactionEmoji(key100)).toBe("💯")

    // Single-codepoint: 🎉 (U+1F389)
    const keyParty = emojiToKey("🎉")
    expect(keyParty).toBe("1f389_e")
    expect(reactionEmoji(keyParty)).toBe("🎉")

    // Single-codepoint: 🧡 (U+1F9E1)
    const keyOrange = emojiToKey("🧡")
    expect(keyOrange).toBe("1f9e1_e")
    expect(reactionEmoji(keyOrange)).toBe("🧡")

    // Multi-codepoint: ❤️ = U+2764 + U+FE0F — naturally has "_", no suffix needed
    // But ❤️ is in the named map, so emojiToKey returns "heart"
    expect(emojiToKey("❤️")).toBe("heart")

    // Multi-codepoint non-named: 👍🏽 (U+1F44D + U+1F3FD)
    const keyThumbsMed = emojiToKey("👍🏽")
    expect(keyThumbsMed).toBe("1f44d_1f3fd")
    expect(reactionEmoji(keyThumbsMed)).toBe("👍")
  })

  it("returns null for empty input", () => {
    expect(emojiToKey("")).toBeNull()
    expect(emojiToKey(null)).toBeNull()
  })
})

describe("DEFAULT_REACTIONS", () => {
  it("is the ordered six defaults with emojis for the quick-react bar", () => {
    expect(DEFAULT_REACTIONS).toEqual([
      { key: "like", emoji: "👍" },
      { key: "heart", emoji: "❤️" },
      { key: "laugh", emoji: "😆" },
      { key: "surprised", emoji: "😮" },
      { key: "sad", emoji: "😢" },
      { key: "angry", emoji: "😠" },
    ])
  })
})
