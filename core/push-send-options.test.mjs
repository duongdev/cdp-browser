import { describe, expect, it } from "vitest"
import { pushSendOptions } from "./push-send-options.js"

describe("pushSendOptions", () => {
  it("returns urgency high and TTL 1800", () => {
    const options = pushSendOptions()
    expect(options.urgency).toBe("high")
    expect(options.TTL).toBe(1800)
  })

  it("only includes urgency and TTL (no contentEncoding)", () => {
    const options = pushSendOptions()
    expect(Object.keys(options).sort()).toEqual(["TTL", "urgency"])
  })

  it("returns the same values on multiple calls (deterministic)", () => {
    const opt1 = pushSendOptions()
    const opt2 = pushSendOptions()
    expect(opt1).toEqual(opt2)
  })
})
