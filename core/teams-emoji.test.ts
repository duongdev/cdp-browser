import { describe, expect, it } from "vitest"
// @ts-expect-error — CJS core module, no types (backend-shared, run under vitest only)
import { DEFAULT_REACTIONS, reactionEmoji } from "./teams-emoji"

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
