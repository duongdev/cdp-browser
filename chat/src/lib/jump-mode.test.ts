import { describe, expect, test } from "vitest"
import { enterJump, extendNewer, JUMP_IDLE, shouldRejoin } from "./jump-mode"

describe("jump mode", () => {
  test("enter → extend → rejoin transitions", () => {
    const s1 = enterJump("m5", true)
    expect(s1.active).toBe(true)
    expect(shouldRejoin(s1)).toBe(false)
    const s2 = extendNewer(s1, true)
    expect(shouldRejoin(s2)).toBe(false)
    const s3 = extendNewer(s2, false)
    expect(shouldRejoin(s3)).toBe(true)
  })

  test("window already at newest on entry rejoins immediately", () => {
    expect(shouldRejoin(enterJump("m5", false))).toBe(true)
  })

  test("idle never rejoins; extend on idle is a no-op", () => {
    expect(shouldRejoin(JUMP_IDLE)).toBe(false)
    expect(extendNewer(JUMP_IDLE, false)).toBe(JUMP_IDLE)
  })
})
