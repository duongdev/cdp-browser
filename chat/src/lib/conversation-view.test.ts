import { describe, expect, it } from "vitest"
import {
  applyPrefs,
  applyReadOverride,
  CHATS_FOLDER,
  conversationLabel,
  folderLabel,
  groupByFolder,
  isMutedNow,
  isUnread,
  knownFolders,
  knownLabels,
  navigableConversations,
  previewLine,
  relativeTime,
  toggleLabel,
} from "./conversation-view"
import type { TeamsConversation } from "./teams-client"

const conv = (over: Partial<TeamsConversation>): TeamsConversation => ({
  id: "19:abc@unq.gbl.spaces",
  kind: "oneOnOne",
  topic: null,
  lastMessageId: null,
  lastMessageVersion: 0,
  lastMessageTs: null,
  lastMessagePreview: "",
  readTs: 0,
  lastMessageFromMe: false,
  unreadSticky: false,
  muted: false,
  ...over,
})

describe("conversationLabel", () => {
  it("prefers the resolved title over the topic (t131)", () => {
    expect(conversationLabel(conv({ title: "Alice, Bob", topic: "Release planning" }))).toBe(
      "Alice, Bob",
    )
  })

  it("falls back to the topic when the title is blank/absent", () => {
    expect(conversationLabel(conv({ title: "  ", topic: "Release planning" }))).toBe(
      "Release planning",
    )
  })

  it("uses the topic when present", () => {
    expect(conversationLabel(conv({ topic: "Release planning" }))).toBe("Release planning")
  })

  it("trims a topic and ignores a blank one", () => {
    expect(conversationLabel(conv({ topic: "  Standup  " }))).toBe("Standup")
    expect(conversationLabel(conv({ topic: "   ", kind: "group" }))).toBe("Group chat")
  })

  it("falls back by kind when there is no topic", () => {
    expect(conversationLabel(conv({ topic: null, kind: "oneOnOne" }))).toBe("Direct message")
    expect(conversationLabel(conv({ topic: null, kind: "group" }))).toBe("Group chat")
    expect(conversationLabel(conv({ topic: null, kind: "self" }))).toBe("Notes")
  })
})

describe("previewLine", () => {
  it("returns the trimmed preview text", () => {
    expect(previewLine(conv({ lastMessagePreview: "  hey there  " }))).toBe("hey there")
  })

  it("strips HTML tags and collapses whitespace", () => {
    expect(previewLine(conv({ lastMessagePreview: "<p>hi <b>team</b></p>\n\n done" }))).toBe(
      "hi team done",
    )
  })

  it("falls back when the preview is empty", () => {
    expect(previewLine(conv({ lastMessagePreview: "" }))).toBe("No messages yet")
  })

  // t151: an inline image becomes a 📷 token — including a tag the store's 500-char cap truncated
  // mid-attribute (the live "okay… <img it…" leak); an emoji img keeps its alt char.
  it("turns inline images into a 📷 token", () => {
    expect(previewLine(conv({ lastMessagePreview: "<img src='x'>" }))).toBe("📷")
    expect(
      previewLine(
        conv({
          lastMessagePreview:
            '<p>okay - this was all I asked <img itemtype="http://schema.skype.com/AMSImage" src="https://as-api.asm.skype.com/v1/objects/x/views/imgo"',
        }),
      ),
    ).toBe("okay - this was all I asked 📷")
    expect(
      previewLine(
        conv({
          lastMessagePreview:
            'yes <img itemtype="http://schema.skype.com/Emoji" alt="😄" src="e.png"> done',
        }),
      ),
    ).toBe("yes 😄 done")
  })

  // t151: the raw last-message content can be a quoted reply, a system event, or a card — the preview
  // must be clean plain text for every shape (mirrors core/teams-render.js previewText).
  it("drops a quoted-reply blockquote, keeping the replier's own words", () => {
    const raw =
      '<p>on it</p><blockquote itemscope itemtype="http://schema.skype.com/Reply"><p itemprop="preview">the original</p></blockquote>'
    expect(previewLine(conv({ lastMessagePreview: raw }))).toBe("on it")
  })

  it("reduces system events and cards to clean labels", () => {
    expect(previewLine(conv({ lastMessagePreview: '<ended/><partlist count="3"/>' }))).toBe(
      "Call ended",
    )
    expect(
      previewLine(conv({ lastMessagePreview: "<topicupdate><value>Sprint</value></topicupdate>" })),
    ).toBe('Renamed to "Sprint"')
    expect(
      previewLine(
        conv({ lastMessagePreview: '<URIObject type="SWIFT.1"><Title>Deploy</Title></URIObject>' }),
      ),
    ).toBe("Deploy")
    expect(
      previewLine(
        conv({
          lastMessagePreview: "<meetingpolicyupdated><value>x</value></meetingpolicyupdated>",
        }),
      ),
    ).toBe("No messages yet")
    expect(
      previewLine(conv({ lastMessagePreview: '{\\"scopeId\\":\\"a\\",\\"callId\\":\\"b\\"}' })),
    ).toBe("No messages yet")
  })

  // t151 mirror gap: a MemberJoined JSON payload must not leak raw property text into the list.
  it("reduces a MemberJoined eventtime payload to a clean line", () => {
    expect(
      previewLine(
        conv({
          lastMessagePreview:
            '{"eventtime":1234567890,"members":[{"friendlyname":"Ada"},{"friendlyname":"Bo"}]}',
        }),
      ),
    ).toBe("Ada and Bo joined the meeting")
    expect(previewLine(conv({ lastMessagePreview: '{"eventtime":1,"members":[]}' }))).toBe(
      "No messages yet",
    )
  })
})

describe("relativeTime", () => {
  const now = 1_700_000_000_000

  it("returns an empty string for a missing timestamp", () => {
    expect(relativeTime(null, now)).toBe("")
  })

  it("buckets recent times", () => {
    expect(relativeTime(now - 5_000, now)).toBe("now")
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3m")
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h")
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d")
  })

  it("returns a non-empty absolute label past a week", () => {
    expect(relativeTime(now - 30 * 86_400_000, now).length).toBeGreaterThan(0)
  })
})

describe("isUnread (t155)", () => {
  it("unread when the last message is newer than readTs and not own", () => {
    expect(isUnread(conv({ lastMessageTs: 200, readTs: 100 }))).toBe(true)
  })

  it("read when readTs covers the last message", () => {
    expect(isUnread(conv({ lastMessageTs: 200, readTs: 200 }))).toBe(false)
    expect(isUnread(conv({ lastMessageTs: 200, readTs: 300 }))).toBe(false)
  })

  it("never unread when the last message is the viewer's own", () => {
    expect(isUnread(conv({ lastMessageTs: 200, readTs: 0, lastMessageFromMe: true }))).toBe(false)
  })

  it("not unread with no last message ts", () => {
    expect(isUnread(conv({ lastMessageTs: null, readTs: 0 }))).toBe(false)
  })

  it("mark-unread sentinel (server zeroes readTs) reads as unread", () => {
    expect(isUnread(conv({ lastMessageTs: 200, readTs: 0, unreadSticky: true }))).toBe(true)
  })
})

describe("applyReadOverride (t155)", () => {
  it("read override raises readTs to its ts and drops the sentinel", () => {
    const c = conv({ lastMessageTs: 200, readTs: 100 })
    const out = applyReadOverride(c, { action: "read", ts: 200 })
    expect(out.readTs).toBe(200)
    expect(isUnread(out)).toBe(false)
  })

  it("read override is a no-op (same ref) once the server covers it", () => {
    const c = conv({ lastMessageTs: 200, readTs: 300 })
    expect(applyReadOverride(c, { action: "read", ts: 200 })).toBe(c)
  })

  it("a LATER message re-arms the dot past a read override", () => {
    const c = conv({ lastMessageTs: 500, readTs: 0 })
    expect(isUnread(applyReadOverride(c, { action: "read", ts: 200 }))).toBe(true)
  })

  it("unread override forces the sticky-unread shape; poll can't clobber", () => {
    const fresh = conv({ lastMessageTs: 200, readTs: 999 }) // server says read
    const out = applyReadOverride(fresh, { action: "unread", ts: 200 })
    expect(out.readTs).toBe(0)
    expect(out.unreadSticky).toBe(true)
    expect(isUnread(out)).toBe(true)
  })

  it("no override → same ref", () => {
    const c = conv({ lastMessageTs: 200 })
    expect(applyReadOverride(c, undefined)).toBe(c)
  })
})

describe("conversation prefs shaping (t156)", () => {
  it("applyPrefs OR's mute and carries labels/folder onto the row", () => {
    const c = conv({ id: "c1", muted: false })
    const out = applyPrefs(c, { labels: ["work"], folder: "Team", muted: true })
    expect(out.muted).toBe(true)
    expect(out.labels).toEqual(["work"])
    expect(out.folder).toBe("Team")
  })

  it("applyPrefs returns the same ref for an empty pref", () => {
    const c = conv({ id: "c1" })
    expect(applyPrefs(c, { labels: [], folder: null, muted: false })).toBe(c)
    expect(applyPrefs(c, undefined)).toBe(c)
  })

  it("isUnread SURVIVES mute (t167 — mute silences delivery only)", () => {
    const c = applyPrefs(conv({ lastMessageTs: 100, readTs: 0 }), {
      labels: [],
      folder: null,
      muted: true,
    })
    expect(c.muted).toBe(true)
    expect(isUnread(c)).toBe(true)
  })

  it("isMutedNow: forever, future window, expired window (t167)", () => {
    const base = { labels: [], folder: null }
    expect(isMutedNow({ ...base, muted: true }, 1000)).toBe(true) // no expiry = forever
    expect(isMutedNow({ ...base, muted: true, mutedUntil: 2000 }, 1000)).toBe(true)
    expect(isMutedNow({ ...base, muted: true, mutedUntil: 500 }, 1000)).toBe(false) // expired
    expect(isMutedNow({ ...base, muted: false, mutedUntil: 2000 }, 1000)).toBe(false)
    expect(isMutedNow(undefined, 1000)).toBe(false)
  })

  it("applyPrefs reads an expired timed mute as unmuted (t167)", () => {
    const c = conv({ id: "c1", muted: false })
    const expired = applyPrefs(c, { labels: [], folder: null, muted: true, mutedUntil: 500 }, 1000)
    expect(expired.muted).toBe(false)
    const active = applyPrefs(c, { labels: [], folder: null, muted: true, mutedUntil: 5000 }, 1000)
    expect(active.muted).toBe(true)
  })

  it("groupByFolder: real folders alpha-first, ungrouped in a trailing Chats section (t158)", () => {
    const rows = [
      applyPrefs(conv({ id: "a" }), { labels: [], folder: "Zeta", muted: false }),
      applyPrefs(conv({ id: "b" }), { labels: [], folder: "Alpha", muted: false }),
      conv({ id: "c" }), // ungrouped
    ]
    const s = groupByFolder(rows)
    expect(s.map((x) => x.folder)).toEqual(["Alpha", "Zeta", CHATS_FOLDER])
    expect(s[2].conversations.map((c) => c.id)).toEqual(["c"])
    expect(folderLabel(CHATS_FOLDER)).toBe("Chats")
  })

  it("groupByFolder: a flat list (no real folders) is one header-less null section (t158)", () => {
    const rows = [conv({ id: "a" }), conv({ id: "b" })]
    const s = groupByFolder(rows)
    expect(s).toHaveLength(1)
    expect(s[0].folder).toBe(null) // no Chats header when there are no real folders
  })

  it("groupByFolder: no ungrouped rows → only the real folder sections, no Chats section (t158)", () => {
    const rows = [applyPrefs(conv({ id: "a" }), { labels: [], folder: "Work", muted: false })]
    const s = groupByFolder(rows)
    expect(s.map((x) => x.folder)).toEqual(["Work"])
  })

  it("navigableConversations: visual order, collapsed folders skipped (t157)", () => {
    const rows = [
      applyPrefs(conv({ id: "z1" }), { labels: [], folder: "Zeta", muted: false }),
      applyPrefs(conv({ id: "a1" }), { labels: [], folder: "Alpha", muted: false }),
      conv({ id: "u1" }), // ungrouped
    ]
    // No collapse: folders alpha-first (Alpha, Zeta), then ungrouped — the render order, not raw.
    expect(navigableConversations(rows).map((c) => c.id)).toEqual(["a1", "z1", "u1"])
    // Zeta collapsed: its rows drop out of the navigable order entirely.
    expect(navigableConversations(rows, new Set(["Zeta"])).map((c) => c.id)).toEqual(["a1", "u1"])
    // The Chats pseudo-folder collapses like any named section (t158).
    expect(navigableConversations(rows, new Set([CHATS_FOLDER])).map((c) => c.id)).toEqual([
      "a1",
      "z1",
    ])
  })

  it("knownFolders / knownLabels are distinct + alpha-sorted", () => {
    const prefs = {
      a: { labels: ["z", "a"], folder: "Work", muted: false },
      b: { labels: ["a"], folder: "Home", muted: false },
    }
    expect(knownFolders(prefs)).toEqual(["Home", "Work"])
    expect(knownLabels(prefs)).toEqual(["a", "z"])
  })

  it("toggleLabel adds then removes", () => {
    expect(toggleLabel([], "x")).toEqual(["x"])
    expect(toggleLabel(["x"], "x")).toEqual([])
    expect(toggleLabel(["x"], " ")).toEqual(["x"])
  })
})
