import { describe, expect, it } from "vitest"
import {
  ACTIONS_INLINE_MIN_WIDTH,
  composerLayoutFor,
  FORMAT_INLINE_MIN_WIDTH,
} from "./composer-layout"

describe("composerLayoutFor", () => {
  it("both inline when wide", () => {
    expect(composerLayoutFor(600)).toEqual({ formatInline: true, actionsInline: true })
  })

  it("format inline at exactly FORMAT_INLINE_MIN_WIDTH", () => {
    expect(composerLayoutFor(FORMAT_INLINE_MIN_WIDTH)).toEqual({
      formatInline: true,
      actionsInline: true,
    })
  })

  it("actions inline but format collapsed between the two breakpoints", () => {
    expect(composerLayoutFor(400)).toEqual({ formatInline: false, actionsInline: true })
  })

  it("actions inline at exactly ACTIONS_INLINE_MIN_WIDTH", () => {
    expect(composerLayoutFor(ACTIONS_INLINE_MIN_WIDTH)).toEqual({
      formatInline: false,
      actionsInline: true,
    })
  })

  it("both collapsed below ACTIONS_INLINE_MIN_WIDTH", () => {
    expect(composerLayoutFor(300)).toEqual({ formatInline: false, actionsInline: false })
  })

  it("both collapsed at zero width", () => {
    expect(composerLayoutFor(0)).toEqual({ formatInline: false, actionsInline: false })
  })

  it("breakpoints are not inverted (actions threshold is lower than format)", () => {
    expect(ACTIONS_INLINE_MIN_WIDTH).toBeLessThan(FORMAT_INLINE_MIN_WIDTH)
  })
})
