import { describe, expect, it } from "vitest"
import { carriesCaption } from "./send-chain"

describe("carriesCaption", () => {
  it("puts the caption on the first send, before anything has landed", () => {
    expect(carriesCaption(null)).toBe(true)
  })

  it("does not repeat the caption once a message has landed", () => {
    expect(carriesCaption("1786073725445")).toBe(false)
  })

  // The regression this exists for: keying the caption on the loop INDEX sends it with the first
  // ATTEMPT, so a failing first upload takes the mentions and quotes down with it and nobody is
  // notified. Keying on what LANDED moves the caption to the next attempt instead.
  it("moves the caption to the next attempt when earlier ones failed", () => {
    let landed: string | null = null
    const carried: number[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      if (carriesCaption(landed)) carried.push(attempt)
      if (attempt === 2) landed = "msg-3" // only the third upload lands
    }
    expect(carried).toEqual([0, 1, 2])
    expect(carriesCaption(landed)).toBe(false)
  })

  it("carries the caption exactly once when the first attempt lands", () => {
    let landed: string | null = null
    const carried: number[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      if (carriesCaption(landed)) carried.push(attempt)
      if (attempt === 0) landed = "msg-1"
    }
    expect(carried).toEqual([0])
  })

  // An empty-string id is a real (if degenerate) server response; it still counts as landed, so the
  // caption must not be sent a second time.
  it("treats an empty id as landed, not as 'nothing yet'", () => {
    expect(carriesCaption("")).toBe(false)
  })
})
