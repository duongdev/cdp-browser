import { describe, expect, test } from "vitest"
import { MAX_HYDRATE_PAGES, planHydrate } from "./hydrate-plan.ts"
import type { ProviderSearchHit } from "./providers/provider.ts"

const hit: ProviderSearchHit = {
  convId: "19:group@thread.v2",
  msgId: "3002",
  preview: "deploy plan",
  sender: "You",
  ts: 1000,
  subject: "",
}

describe("planHydrate", () => {
  test("skip when the hit's message is already in chat.db (idempotent fast path)", () => {
    expect(planHydrate(hit, true)).toEqual({ action: "skip" })
  })

  test("fetch the conv window around the hit when missing", () => {
    expect(planHydrate(hit, false)).toEqual({
      action: "fetch",
      convId: "19:group@thread.v2",
      aroundMsgId: "3002",
    })
  })

  test("fetch reads convId/msgId straight off the hit (no synthesis)", () => {
    const out = planHydrate({ ...hit, convId: "c2", msgId: "m9" }, false)
    expect(out).toEqual({ action: "fetch", convId: "c2", aroundMsgId: "m9" })
  })

  test("MAX_HYDRATE_PAGES is the documented ponytail ceiling (small int)", () => {
    expect(Number.isInteger(MAX_HYDRATE_PAGES)).toBe(true)
    expect(MAX_HYDRATE_PAGES).toBeGreaterThan(0)
    expect(MAX_HYDRATE_PAGES).toBeLessThanOrEqual(50)
  })
})
