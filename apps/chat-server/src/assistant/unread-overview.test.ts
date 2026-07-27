import Database from "better-sqlite3"
import { beforeEach, describe, expect, test } from "vitest"
import { migrate, setPrefs, setReadHorizon, upsertConversations, upsertMessages } from "../store.ts"
import { getUnreadOverview } from "./unread-overview.ts"

function freshDb() {
  const db = new Database(":memory:")
  migrate(db)
  return db
}

describe("getUnreadOverview", () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    upsertConversations(db, "teams", [
      { id: "c1", title: "Deploy crew", lastMessageVersion: 1, lastMessageTs: 3000 },
      { id: "c2", title: "Muted room", lastMessageVersion: 1, lastMessageTs: 3000 },
      { id: "c3", title: "All read", lastMessageVersion: 1, lastMessageTs: 1000 },
    ])
    upsertMessages(db, "teams", "c1", [
      { id: "m1", ts: 1000, senderName: "Bob", body: "<p>read already</p>" },
      { id: "m2", ts: 2000, senderName: "Bob", body: "<p>deploy xong</p>" },
      { id: "m3", ts: 3000, senderName: "An", body: `<p>${"x".repeat(500)}</p>` },
    ])
    upsertMessages(db, "teams", "c2", [{ id: "m4", ts: 3000, senderName: "Zed", body: "psst" }])
    upsertMessages(db, "teams", "c3", [{ id: "m5", ts: 1000, senderName: "Bob", body: "old" }])
    setReadHorizon(db, "teams", "c1", 1000)
    setReadHorizon(db, "teams", "c3", 2000)
    setPrefs(db, "teams", "c2", { muted: true })
  })

  test("unread math per conversation, read conversations skipped", () => {
    const overview = getUnreadOverview(db, "teams")
    expect(overview.map((c) => c.convId)).toEqual(["c1"])
    expect(overview[0].unreadCount).toBe(2)
    expect(overview[0].excerpts.map((e) => e.msgId)).toEqual(["m2", "m3"])
    expect(overview[0].excerpts[0].text).toBe("deploy xong")
  })

  test("mute filtering: locally-muted skipped by default, includeMuted brings it back", () => {
    expect(getUnreadOverview(db, "teams").some((c) => c.convId === "c2")).toBe(false)
    expect(
      getUnreadOverview(db, "teams", { includeMuted: true }).some((c) => c.convId === "c2"),
    ).toBe(true)
  })

  test("excerpt caps: chars bounded", () => {
    const c1 = getUnreadOverview(db, "teams").find((c) => c.convId === "c1")
    for (const e of c1?.excerpts ?? []) expect(e.text.length).toBeLessThanOrEqual(160)
  })

  test("own last message → not a to-do; deleted messages excluded", () => {
    upsertConversations(db, "teams", [
      {
        id: "c4",
        title: "Me last",
        lastMessageVersion: 1,
        lastMessageTs: 5000,
        lastMessageFromMe: true,
      },
    ])
    upsertMessages(db, "teams", "c4", [{ id: "m6", ts: 5000, body: "mine" }])
    expect(getUnreadOverview(db, "teams").some((c) => c.convId === "c4")).toBe(false)
  })
})
