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
