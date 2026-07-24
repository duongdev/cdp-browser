import { describe, expect, it } from "vitest"
import { soundFileFor } from "./notify-sound"

describe("soundFileFor", () => {
  it("returns null for none", () => expect(soundFileFor("none")).toBeNull())
  it("maps tap", () => expect(soundFileFor("tap")).toBe("/chat/sounds/tap.wav"))
  it("maps polite", () => expect(soundFileFor("polite")).toBe("/chat/sounds/polite.wav"))
  it("maps calm", () => expect(soundFileFor("calm")).toBe("/chat/sounds/calm.wav"))
})
