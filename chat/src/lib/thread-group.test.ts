import { describe, expect, it } from "vitest"
import type { TeamsMessage } from "./teams-client"
import { buildThreadItems, dateSeparatorLabel } from "./thread-group"

const AT = (y: number, mo: number, d: number, h = 12, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()

const msg = (over: Partial<TeamsMessage> & { ts: number }): TeamsMessage => ({
  id: String(over.ts),
  body: "hi",
  senderId: "u1",
  senderName: "Alice",
  ...over,
})

describe("dateSeparatorLabel", () => {
  const now = AT(2026, 7, 23, 15) // Thu, Jul 23 2026

  it("labels today / yesterday relative to now", () => {
    expect(dateSeparatorLabel(AT(2026, 7, 23, 9), now)).toBe("Today")
    expect(dateSeparatorLabel(AT(2026, 7, 22, 9), now)).toBe("Yesterday")
  })

  it("this-year day uses weekday + month/day, no year", () => {
    const label = dateSeparatorLabel(AT(2026, 7, 21, 9), now)
    expect(label).toMatch(/Jul/)
    expect(label).toMatch(/21/)
    expect(label).not.toMatch(/2026/)
  })

  it("a past-year day includes the year", () => {
    expect(dateSeparatorLabel(AT(2025, 12, 12, 9), now)).toMatch(/2025/)
  })
})

describe("buildThreadItems", () => {
  const now = AT(2026, 7, 23, 15)

  it("opens each calendar day with one date separator, above the day's first message", () => {
    const items = buildThreadItems(
      [msg({ ts: AT(2026, 7, 22, 10) }), msg({ ts: AT(2026, 7, 23, 10) })],
      now,
    )
    expect(items.map((i) => i.type)).toEqual(["date", "message", "date", "message"])
    expect(items[0]).toMatchObject({ type: "date", label: "Yesterday" })
    expect(items[2]).toMatchObject({ type: "date", label: "Today" })
  })

  it("groups a run from one sender within 5min — leader shows meta, followers don't", () => {
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0), id: "a" }),
        msg({ ts: AT(2026, 7, 23, 10, 2), id: "b" }),
        msg({ ts: AT(2026, 7, 23, 10, 4), id: "c" }),
      ],
      now,
    )
    const metas = items.filter((i) => i.type === "message").map((i) => (i as any).showMeta)
    expect(metas).toEqual([true, false, false])
  })

  it("breaks the group on a >5min gap", () => {
    const items = buildThreadItems(
      [msg({ ts: AT(2026, 7, 23, 10, 0) }), msg({ ts: AT(2026, 7, 23, 10, 6) })],
      now,
    )
    const metas = items.filter((i) => i.type === "message").map((i) => (i as any).showMeta)
    expect(metas).toEqual([true, true])
  })

  it("breaks the group on a different sender and on own-vs-other", () => {
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0), senderId: "u1" }),
        msg({ ts: AT(2026, 7, 23, 10, 1), senderId: "u2", senderName: "Bob" }),
        msg({ ts: AT(2026, 7, 23, 10, 2), self: true, senderName: "You" }),
        msg({ ts: AT(2026, 7, 23, 10, 3), self: true, senderName: "You" }),
      ],
      now,
    )
    const metas = items.filter((i) => i.type === "message").map((i) => (i as any).showMeta)
    expect(metas).toEqual([true, true, true, false])
  })

  it("a system line never groups, carries no meta, and breaks the surrounding run", () => {
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0), id: "a" }),
        msg({ ts: AT(2026, 7, 23, 10, 1), id: "sys", kind: "system", body: "Call ended" }),
        msg({ ts: AT(2026, 7, 23, 10, 2), id: "b" }),
      ],
      now,
    )
    const m = items.filter((i) => i.type === "message")
    expect((m[0] as any).showMeta).toBe(true)
    expect((m[1] as any).showMeta).toBe(false) // system
    expect((m[2] as any).showMeta).toBe(true) // run broken by the system line
  })

  it("a day boundary forces a fresh leader even within 5min wall-clock", () => {
    const items = buildThreadItems(
      [msg({ ts: AT(2026, 7, 22, 23, 59) }), msg({ ts: AT(2026, 7, 23, 0, 1) })],
      now,
    )
    const metas = items.filter((i) => i.type === "message").map((i) => (i as any).showMeta)
    expect(metas).toEqual([true, true])
  })
})
