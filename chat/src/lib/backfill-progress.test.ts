import { describe, expect, it } from "vitest"
import type { BackfillStatus } from "../../../apps/chat-server/src/contract"
import { progressLabel, progressPercent } from "./backfill-progress"

function status(overrides: Partial<BackfillStatus> = {}): BackfillStatus {
  return {
    running: false,
    days: 30,
    conversationsDone: 0,
    conversationsTotal: 0,
    messagesFetched: 0,
    ...overrides,
  }
}

describe("progressPercent", () => {
  it("returns 0 when total is 0", () => expect(progressPercent(0, 0)).toBe(0))
  it("returns 0 when done is 0", () => expect(progressPercent(0, 10)).toBe(0))
  it("returns 100 when done equals total", () => expect(progressPercent(5, 5)).toBe(100))
  it("rounds to nearest integer", () => expect(progressPercent(1, 3)).toBe(33))
  it("clamps at 100", () => expect(progressPercent(11, 10)).toBe(100))
})

describe("progressLabel", () => {
  it("returns empty string when nothing has run", () => expect(progressLabel(status())).toBe(""))
  it("shows error text on error", () =>
    expect(progressLabel(status({ error: "rate_limit" }))).toBe("rate_limit"))
  it("formats in-progress label", () =>
    expect(
      progressLabel(
        status({
          running: true,
          conversationsDone: 3,
          conversationsTotal: 10,
          messagesFetched: 42,
        }),
      ),
    ).toBe("3 / 10 conversations · 42 messages"))
  it("formats done label (not running, done > 0)", () =>
    expect(
      progressLabel(status({ conversationsDone: 5, conversationsTotal: 5, messagesFetched: 120 })),
    ).toBe("5 / 5 conversations · 120 messages"))
})
