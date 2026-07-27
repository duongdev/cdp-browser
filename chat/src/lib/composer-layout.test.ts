import { describe, expect, it } from "vitest"
import {
  ACTIONS_INLINE_MEASURED,
  ACTIONS_INLINE_MIN_WIDTH,
  composerLayoutFor,
  FORMAT_INLINE_MEASURED,
  FORMAT_INLINE_MIN_WIDTH,
} from "./composer-layout"

describe("composerLayoutFor", () => {
  it("both inline when wide", () => {
    expect(composerLayoutFor(1000)).toEqual({ formatInline: true, actionsInline: true })
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
    expect(composerLayoutFor(ACTIONS_INLINE_MIN_WIDTH - 1)).toEqual({
      formatInline: false,
      actionsInline: false,
    })
  })

  it("both collapsed at zero width", () => {
    expect(composerLayoutFor(0)).toEqual({ formatInline: false, actionsInline: false })
  })

  it("breakpoints are not inverted (actions threshold is lower than format)", () => {
    expect(ACTIONS_INLINE_MIN_WIDTH).toBeLessThan(FORMAT_INLINE_MIN_WIDTH)
  })

  // THE INVARIANT (PSN-105 G): the footer row must never wrap. A chosen layout is only legal at a
  // width that fits its measured content width. Sweeping every width from 0 to 1200 catches the
  // regression that shipped — 480…640, where BOTH clusters went inline into a 640px-wide row.
  it("never selects a layout wider than the space available", () => {
    for (let w = 0; w <= 1200; w++) {
      const { formatInline, actionsInline } = composerLayoutFor(w)
      const required = formatInline
        ? FORMAT_INLINE_MEASURED
        : actionsInline
          ? ACTIONS_INLINE_MEASURED
          : 0
      expect(
        required,
        `width ${w} chose format=${formatInline} actions=${actionsInline}, which needs ${required}px`,
      ).toBeLessThanOrEqual(w)
    }
  })

  it("format collapses before actions do (no actions-collapsed-but-format-inline band)", () => {
    for (let w = 0; w <= 1200; w++) {
      const { formatInline, actionsInline } = composerLayoutFor(w)
      if (formatInline) expect(actionsInline).toBe(true)
    }
  })
})
