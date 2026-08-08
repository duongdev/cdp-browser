import { describe, expect, it } from "vitest"
import { buildChatMessageUrl, buildTeamsMessageUrl, parseMessageUrl } from "./message-url"

describe("buildChatMessageUrl", () => {
  it("builds the app deep link", () => {
    expect(buildChatMessageUrl("conv1", "msg2", "https://example.com")).toBe(
      "https://example.com/chat/c/conv1?msg=msg2",
    )
  })
})

describe("buildTeamsMessageUrl", () => {
  // Byte-for-byte the URL Teams' own "Copy link" produced on a live client (PSN-105 H),
  // with the real conversation id swapped for a fake one.
  it("matches the format Teams' own Copy link emits", () => {
    expect(buildTeamsMessageUrl("19:abc@thread.v2", "1785158747611")).toBe(
      "https://teams.microsoft.com/l/message/19:abc@thread.v2/1785158747611?context=%7B%22contextType%22%3A%22chat%22%7D",
    )
  })

  it("keeps the chat context param, which routes the link to the chat app", () => {
    const ctx = new URL(buildTeamsMessageUrl("19:abc@thread.v2", "1")).searchParams.get("context")
    expect(JSON.parse(ctx ?? "")).toEqual({ contextType: "chat" })
  })
})

describe("parseMessageUrl", () => {
  const ORIGIN = "https://portal.example.com"

  it("round-trips a link this app built", () => {
    const url = buildTeamsMessageUrl("19:abc@thread.v2", "1785158747611")
    expect(parseMessageUrl(url, ORIGIN)).toEqual({
      convId: "19:abc@thread.v2",
      msgId: "1785158747611",
    })
  })

  it("parses a Teams link without the context param", () => {
    expect(
      parseMessageUrl("https://teams.microsoft.com/l/message/19:x@thread.v2/17", ORIGIN),
    ).toEqual({ convId: "19:x@thread.v2", msgId: "17" })
  })

  it("parses a percent-encoded conversation id", () => {
    expect(
      parseMessageUrl("https://teams.microsoft.com/l/message/19%3Ax%40thread.v2/17", ORIGIN),
    ).toEqual({ convId: "19:x@thread.v2", msgId: "17" })
  })

  it("accepts the regional teams host", () => {
    expect(
      parseMessageUrl("https://teams.microsoft.us/l/message/19:x@thread.v2/17", ORIGIN),
    ).toEqual({ convId: "19:x@thread.v2", msgId: "17" })
  })

  it("parses this app's own /chat/c/…?msg= deep link", () => {
    expect(parseMessageUrl(buildChatMessageUrl("19:x@thread.v2", "17", ORIGIN), ORIGIN)).toEqual({
      convId: "19:x@thread.v2",
      msgId: "17",
    })
  })

  it("returns null for a chat link with no ?msg= target", () => {
    expect(parseMessageUrl(`${ORIGIN}/chat/c/19:x@thread.v2`, ORIGIN)).toBeNull()
  })

  // A same-path link on ANOTHER origin is somebody else's deployment, not ours — resolving it
  // in-app would jump to whatever conversation happens to share that id here.
  it("rejects a /chat/c/ link from a different origin", () => {
    expect(
      parseMessageUrl("https://evil.example.com/chat/c/19:x@thread.v2?msg=17", ORIGIN),
    ).toBeNull()
  })

  // The real bypass shape: a suffix check (`host.endsWith("teams.microsoft.com")`) accepts this,
  // because the attacker simply prefixes the allowed domain. `evil.attacker.test` style suffixes
  // are NOT the interesting case — those fail a suffix check too.
  it("rejects a lookalike host that merely ends with the teams domain", () => {
    expect(
      parseMessageUrl("https://evilteams.microsoft.com/l/message/19:x@thread.v2/17", ORIGIN),
    ).toBeNull()
    expect(
      parseMessageUrl("https://notteams.microsoft.com/l/message/19:x@thread.v2/17", ORIGIN),
    ).toBeNull()
  })

  it("still accepts a genuine subdomain of an allowed host", () => {
    expect(
      parseMessageUrl("https://eu.teams.microsoft.com/l/message/19:x@thread.v2/17", ORIGIN),
    ).toEqual({ convId: "19:x@thread.v2", msgId: "17" })
  })

  // Defense in depth: a `javascript:` URL has an empty hostname and a "null" origin, so it already
  // fails both branches. The explicit scheme check keeps it that way if either branch ever loosens.
  it("rejects non-http(s) schemes", () => {
    expect(
      parseMessageUrl("javascript:alert(1)//teams.microsoft.com/l/message/a/1", ORIGIN),
    ).toBeNull()
    expect(
      parseMessageUrl("ftp://teams.microsoft.com/l/message/19:x@thread.v2/17", ORIGIN),
    ).toBeNull()
  })

  it("rejects unrelated urls and junk", () => {
    expect(parseMessageUrl("https://teams.microsoft.com/l/channel/19:x/General", ORIGIN)).toBeNull()
    expect(parseMessageUrl("https://example.com", ORIGIN)).toBeNull()
    expect(parseMessageUrl("not a url", ORIGIN)).toBeNull()
    expect(parseMessageUrl("", ORIGIN)).toBeNull()
  })

  // The href comes from a message another party authored, so it is untrusted input. A malformed
  // %-escape makes decodeURIComponent throw a URIError; the contract is to return null and let the
  // link stay external, never to throw inside a click handler.
  it("returns null instead of throwing on malformed percent-encoding", () => {
    expect(() =>
      parseMessageUrl("https://teams.microsoft.com/l/message/%E0%A4%A/17", ORIGIN),
    ).not.toThrow()
    expect(parseMessageUrl("https://teams.microsoft.com/l/message/%E0%A4%A/17", ORIGIN)).toBeNull()
    expect(
      parseMessageUrl("https://teams.microsoft.com/l/message/19:x@thread.v2/%%", ORIGIN),
    ).toBeNull()
    expect(parseMessageUrl(`${ORIGIN}/chat/c/%E0%A4%A?msg=17`, ORIGIN)).toBeNull()
  })

  // Message ids are Teams arrival-ms. A non-numeric segment is junk or an injection attempt, and
  // it must not reach the jump path. (`../etc` is a weaker case — the URL parser normalizes it
  // away before the id check ever runs.)
  it("rejects a message id that is not digits", () => {
    expect(
      parseMessageUrl("https://teams.microsoft.com/l/message/19:x@thread.v2/abc", ORIGIN),
    ).toBeNull()
    expect(
      parseMessageUrl("https://teams.microsoft.com/l/message/19:x@thread.v2/12ab", ORIGIN),
    ).toBeNull()
    expect(parseMessageUrl(`${ORIGIN}/chat/c/19:x@thread.v2?msg=abc`, ORIGIN)).toBeNull()
  })
})
