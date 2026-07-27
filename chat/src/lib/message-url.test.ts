import { describe, expect, it } from "vitest"
import { buildChatMessageUrl, buildTeamsMessageUrl } from "./message-url"

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
