import { describe, expect, it } from "vitest"
import { formatBackfillRun, formatRelativeTime, syncEventLabel } from "./sync-log"

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

describe("formatBackfillRun", () => {
  it("formats a successful run", () => {
    expect(
      formatBackfillRun(
        {
          id: "1",
          startedAt: 0,
          finishedAt: 0,
          days: 30,
          conversations: 24,
          messages: 1203,
          status: "ok",
        },
        0,
      ),
    ).toBe("30d · 24 convs · 1,203 msgs")
  })

  it("formats an error run", () => {
    expect(
      formatBackfillRun(
        {
          id: "1",
          startedAt: 0,
          finishedAt: 0,
          days: 30,
          conversations: 5,
          messages: 100,
          status: "error",
          error: "rate_limit",
        },
        0,
      ),
    ).toBe("30d · failed: rate_limit")
  })

  it("formats aborted", () => {
    expect(
      formatBackfillRun(
        {
          id: "1",
          startedAt: 0,
          finishedAt: 0,
          days: 7,
          conversations: 0,
          messages: 0,
          status: "aborted",
        },
        0,
      ),
    ).toBe("7d · aborted")
  })
})

describe("syncEventLabel", () => {
  const at = (over: Partial<Parameters<typeof syncEventLabel>[0]>) =>
    syncEventLabel({ kind: "list", ts: 0, ok: true, ...over })

  it("labels a service-level event by its lane", () => {
    expect(at({ kind: "list" })).toBe("list")
  })

  it("names the conversation a per-conversation failure happened on", () => {
    expect(at({ kind: "focus", ok: false, code: "not_found", convId: "19:abcdef@thread.v2" })).toBe(
      "focus · abcdef",
    )
  })

  it("truncates a long conversation id", () => {
    expect(at({ kind: "focus", convId: "19:0123456789abcdef@thread.v2" })).toBe(
      "focus · 0123456789ab…",
    )
  })

  it("falls back to the bare lane when a focus event carries no convId", () => {
    expect(at({ kind: "focus" })).toBe("focus")
  })
})
