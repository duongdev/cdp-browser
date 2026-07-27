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
  it("includes convId and msgId in the deep link", () => {
    const url = buildTeamsMessageUrl("19:abc@thread.v2", "1234567890")
    expect(url).toContain("19:abc@thread.v2")
    expect(url).toContain("1234567890")
    expect(url.startsWith("https://teams.microsoft.com/l/message/")).toBe(true)
  })
})
