import { describe, expect, it } from "vitest"
import type { ChatConversation } from "./contract.ts"
import { toConversationInput } from "./upsert-map.ts"

const conv = (over: Partial<ChatConversation> & Pick<ChatConversation, "id">): ChatConversation =>
  ({
    id: "19:group@thread.v2",
    service: "teams",
    kind: "group",
    topic: null,
    lastMessageId: "1",
    lastMessageVersion: 1,
    lastMessageTs: 1,
    lastMessagePreview: "hi",
    lastMessageFromMe: false,
    readTs: 0,
    unreadSticky: false,
    muted: false,
    ...over,
  }) as ChatConversation

describe("toConversationInput", () => {
  // PSN-113 C-fix regression: the seam resolves lastMessageSender from the raw conv-list
  // payload and the provider forwards it, but the sweep persists via this mapper — it MUST
  // carry lastMessageSender through or the preview prefix never lands on the BFF row.
  it("carries lastMessageSender through to the store input", () => {
    expect(toConversationInput(conv({ lastMessageSender: "Glory Nguyen" })).lastMessageSender).toBe(
      "Glory Nguyen",
    )
  })

  it("omits lastMessageSender cleanly when absent (undefined, not a stray key)", () => {
    const out = toConversationInput(conv({ lastMessageSender: undefined }))
    expect(out.lastMessageSender).toBeUndefined()
  })
})
