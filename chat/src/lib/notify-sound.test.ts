import { describe, expect, it } from "vitest"
import { soundFileFor } from "./notify-sound"

describe("soundFileFor", () => {
  it("returns null for none", () => expect(soundFileFor("none")).toBeNull())
  it("maps chime-1", () => expect(soundFileFor("chime-1")).toBe("/chat/sounds/chime-1.wav"))
  it("maps chime-2", () => expect(soundFileFor("chime-2")).toBe("/chat/sounds/chime-2.wav"))
  it("maps chime-3", () => expect(soundFileFor("chime-3")).toBe("/chat/sounds/chime-3.wav"))
})
