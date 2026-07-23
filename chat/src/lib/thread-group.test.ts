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
    // t160: a day-crossing separator carries the day + the time (Messenger-style).
    expect((items[0] as any).label).toMatch(/^Yesterday /)
    expect((items[2] as any).label).toMatch(/^Today /)
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

  it("a ≥20-min same-day idle gap inserts a time-only separator (t160)", () => {
    const items = buildThreadItems(
      [msg({ ts: AT(2026, 7, 23, 10, 0) }), msg({ ts: AT(2026, 7, 23, 10, 25) })],
      now,
    )
    expect(items.map((i) => i.type)).toEqual(["date", "message", "date", "message"])
    // Same-day separator: time only, no day part.
    expect((items[2] as any).label).not.toMatch(/Today/)
    expect((items[2] as any).label).toMatch(/10[:.]25|25/)
  })

  it("a 6–19min gap breaks the sender group but adds no separator", () => {
    const items = buildThreadItems(
      [msg({ ts: AT(2026, 7, 23, 10, 0) }), msg({ ts: AT(2026, 7, 23, 10, 10) })],
      now,
    )
    expect(items.map((i) => i.type)).toEqual(["date", "message", "message"])
    const metas = items.filter((i) => i.type === "message").map((i) => (i as any).showMeta)
    expect(metas).toEqual([true, true])
  })

  it("places one New marker before the first unread non-self message (t160)", () => {
    const readTs = AT(2026, 7, 23, 10, 1)
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0), id: "read" }),
        msg({ ts: AT(2026, 7, 23, 10, 2), id: "mine", self: true, senderName: "You" }),
        msg({ ts: AT(2026, 7, 23, 10, 3), id: "unread1" }),
        msg({ ts: AT(2026, 7, 23, 10, 4), id: "unread2" }),
      ],
      now,
      readTs,
    )
    const newIdx = items.findIndex((i) => i.type === "new")
    expect(newIdx).toBeGreaterThan(-1)
    expect(items.filter((i) => i.type === "new")).toHaveLength(1)
    // The marker sits immediately before the first non-self unread message.
    expect(items[newIdx + 1]).toMatchObject({ type: "message", key: "unread1" })
  })

  it("emits no New marker when everything is read or only self messages are newer", () => {
    const readTs = AT(2026, 7, 23, 10, 5)
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0) }),
        msg({ ts: AT(2026, 7, 23, 10, 6), self: true, senderName: "You" }),
      ],
      now,
      readTs,
    )
    expect(items.some((i) => i.type === "new")).toBe(false)
  })
})

describe("groupPos (t169, asymmetric bubble corners)", () => {
  const now = AT(2026, 7, 23, 15)

  const positions = (items: ReturnType<typeof buildThreadItems>) =>
    items.filter((i) => i.type === "message").map((i) => (i.type === "message" ? i.groupPos : null))

  it("a lone message is solo", () => {
    const items = buildThreadItems([msg({ ts: AT(2026, 7, 23, 10, 0) })], now)
    expect(positions(items)).toEqual(["solo"])
  })

  it("a same-sender run stamps first/middle/last", () => {
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0), id: "a" }),
        msg({ ts: AT(2026, 7, 23, 10, 1), id: "b" }),
        msg({ ts: AT(2026, 7, 23, 10, 2), id: "c" }),
      ],
      now,
    )
    expect(positions(items)).toEqual(["first", "middle", "last"])
  })

  it("a sender change splits runs (two-message run = first/last)", () => {
    const items = buildThreadItems(
      [
        msg({ ts: AT(2026, 7, 23, 10, 0), id: "a" }),
        msg({ ts: AT(2026, 7, 23, 10, 1), id: "b" }),
        msg({ ts: AT(2026, 7, 23, 10, 2), id: "c", senderId: "u2", senderName: "Bob" }),
      ],
      now,
    )
    expect(positions(items)).toEqual(["first", "last", "solo"])
  })

  it("a group-window gap breaks the run into solos", () => {
    const items = buildThreadItems(
      [msg({ ts: AT(2026, 7, 23, 10, 0), id: "a" }), msg({ ts: AT(2026, 7, 23, 10, 10), id: "b" })],
      now,
    )
    expect(positions(items)).toEqual(["solo", "solo"])
  })
})
