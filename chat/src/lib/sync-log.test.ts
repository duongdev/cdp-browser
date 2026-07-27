import { describe, expect, it } from "vitest"
import { formatRelativeTime } from "./sync-log"

const SEC = 1_000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe("formatRelativeTime", () => {
  it("returns 'just now' when diff < 5s", () => {
    expect(formatRelativeTime(1000, 1004)).toBe("just now")
    expect(formatRelativeTime(1000, 1000)).toBe("just now")
  })

  it("returns seconds for 5s–59s", () => {
    expect(formatRelativeTime(0, 5 * SEC)).toBe("5s ago")
    expect(formatRelativeTime(0, 59 * SEC)).toBe("59s ago")
  })

  it("returns minutes for 60s–59m59s", () => {
    expect(formatRelativeTime(0, 60 * SEC)).toBe("1m ago")
    expect(formatRelativeTime(0, 90 * SEC)).toBe("1m ago")
    expect(formatRelativeTime(0, 59 * MIN + 59 * SEC)).toBe("59m ago")
  })

  it("returns hours for 1h–23h59m", () => {
    expect(formatRelativeTime(0, 60 * MIN)).toBe("1h ago")
    expect(formatRelativeTime(0, 23 * HOUR + 59 * MIN)).toBe("23h ago")
  })

  it("returns days for >= 24h", () => {
    expect(formatRelativeTime(0, DAY)).toBe("1d ago")
    expect(formatRelativeTime(0, 3 * DAY)).toBe("3d ago")
  })
})
