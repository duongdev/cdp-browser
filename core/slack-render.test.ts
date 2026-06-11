import { describe, expect, it } from "vitest"
import { composeTitle, renderBody, toReaderMessages } from "./slack-render"

const names = {
  users: { U_ME: "Me", U_ALICE: "Alice", U_BOB: "Bob" },
  channels: { C_GEN: "general", C_RAND: "random" },
}

describe("renderBody — mentions", () => {
  it("resolves <@U…> to @name from the map", () => {
    expect(renderBody("hey <@U_ALICE> ping", names)).toBe("hey @Alice ping")
  })
  it("falls back to the raw id when the user is unknown", () => {
    expect(renderBody("hi <@U_NEW>", names)).toBe("hi @U_NEW")
  })
  it("uses the inline label when Slack provides one", () => {
    expect(renderBody("hi <@U_X|charlie>", names)).toBe("hi @charlie")
  })
  it("resolves @here/@channel/@everyone broadcasts", () => {
    expect(renderBody("<!here> standup", names)).toBe("@here standup")
    expect(renderBody("<!channel> ping", names)).toBe("@channel ping")
    expect(renderBody("<!everyone> hi", names)).toBe("@everyone hi")
  })
  it("renders a subteam mention from its inline label", () => {
    expect(renderBody("<!subteam^S1|@frontend> deploy", names)).toBe("@frontend deploy")
    expect(renderBody("<!subteam^S1> deploy", names)).toBe("@team deploy")
  })
})

describe("renderBody — channel refs + links", () => {
  it("resolves <#C…|name> and <#C…> to #name", () => {
    expect(renderBody("see <#C_GEN|general>", names)).toBe("see #general")
    expect(renderBody("see <#C_RAND>", names)).toBe("see #random")
    expect(renderBody("see <#C_UNK>", names)).toBe("see #C_UNK")
  })
  it("renders a link as its label, else the bare url", () => {
    expect(renderBody("docs <https://x.com/a|the docs>", names)).toBe("docs the docs")
    expect(renderBody("see <https://x.com/a>", names)).toBe("see https://x.com/a")
    expect(renderBody("mail <mailto:a@b.com|email me>", names)).toBe("mail email me")
  })
})

describe("renderBody — formatting + entities", () => {
  it("strips bold/italic/strike/code markers", () => {
    expect(renderBody("*bold* _it_ ~no~ `c`", names)).toBe("bold it no c")
  })
  it("strips a fenced code block to its contents", () => {
    expect(renderBody("see ```const x = 1``` end", names)).toBe("see const x = 1 end")
  })
  it("unescapes HTML entities Slack encodes", () => {
    expect(renderBody("a &amp; b &lt;tag&gt;", names)).toBe("a & b <tag>")
  })
  it("collapses newlines to single spaces for a one-line toast", () => {
    expect(renderBody("line1\n\nline2", names)).toBe("line1 line2")
  })
  it("returns a fallback for an empty body (attachment-only message)", () => {
    expect(renderBody("", names)).toBe("(attachment)")
    expect(renderBody("   ", names)).toBe("(attachment)")
  })
})

describe("composeTitle", () => {
  it("is '{sender} in {channel}' for a channel message", () => {
    expect(composeTitle({ senderName: "Alice", channelName: "general", kind: "channel" })).toBe(
      "Alice in #general",
    )
  })
  it("is just the sender for a DM", () => {
    expect(composeTitle({ senderName: "Bob", channelName: null, kind: "im" })).toBe("Bob")
  })
  it("is '{sender} in {group}' for a group DM (mpim)", () => {
    expect(composeTitle({ senderName: "Bob", channelName: "mpdm-a--b--c", kind: "mpim" })).toBe(
      "Bob in mpdm-a--b--c",
    )
  })
  it("treats a thread reply like its channel", () => {
    expect(composeTitle({ senderName: "Al", channelName: "dev", kind: "thread" })).toBe(
      "Al in #dev",
    )
  })
  it("falls back to the workspace when the sender is unknown", () => {
    expect(
      composeTitle({ senderName: "", channelName: "general", kind: "channel", workspace: "Acme" }),
    ).toBe("Acme")
  })
})

describe("toReaderMessages", () => {
  const raw = [
    { ts: "300.000200", user: "U_BOB", text: "see <#C_GEN>" },
    { ts: "200.000100", user: "U_ALICE", text: "*hi* <@U_ME>" },
    { ts: "100.000050", user: "U_OLD", subtype: "channel_join", text: "joined" },
  ]

  it("returns oldest-first rendered messages with sender names", () => {
    const out = toReaderMessages(raw, names, "U_ME")
    expect(out.map((m) => m.ts)).toEqual(["200.000100", "300.000200"])
    expect(out[0]).toMatchObject({
      senderName: "Alice",
      body: "hi @Me",
      self: false,
      tsMs: 200000,
    })
    expect(out[1].body).toBe("see #general")
  })

  it("drops subtype noise (joins/leaves) but keeps bot messages", () => {
    const out = toReaderMessages(
      [
        { ts: "2.0", bot_id: "B1", subtype: "bot_message", username: "Deploy Bot", text: "done" },
        { ts: "1.0", user: "U_X", subtype: "channel_leave", text: "left" },
      ],
      names,
      "U_ME",
    )
    expect(out).toHaveLength(1)
    expect(out[0].senderName).toBe("Deploy Bot")
  })

  it("flags the viewer's own messages", () => {
    const out = toReaderMessages([{ ts: "1.0", user: "U_ME", text: "mine" }], names, "U_ME")
    expect(out[0].self).toBe(true)
  })

  it("falls back to a placeholder sender for unknown users", () => {
    const out = toReaderMessages([{ ts: "1.0", user: "U_NOPE", text: "x" }], names, "U_ME")
    expect(out[0].senderName).toBe("U_NOPE")
  })
})
