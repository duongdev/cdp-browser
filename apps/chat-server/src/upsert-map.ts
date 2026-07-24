// Shared contract-row → store-input mappers (PSN-93). Both the routes (WS-C) and the sweep/backfill
// engines (WS-D) persist provider rows the same way, so the mapping lives here once. Decision 10:
// the whole message is kept as `raw` so future consumers aren't limited to the rendered body.

import type { ChatConversation, ChatMessage } from "./contract.ts"
import type { ConversationInput, MessageInput } from "./store.ts"

/** A ChatMessage → the store's MessageInput (keeps the whole message as `raw`). */
export function toMessageInput(m: ChatMessage): MessageInput {
  return {
    id: m.id,
    senderId: m.senderId ?? null,
    senderName: m.senderName ?? null,
    ts: m.ts,
    body: m.body,
    raw: m,
    deleted: m.deleted,
    edited: m.edited,
    mentionsMe: m.mentionsMe,
  }
}

/** A ChatConversation (or a partial with the same field names) → the store's ConversationInput. */
export function toConversationInput(
  c: Partial<ChatConversation> & Pick<ChatConversation, "id">,
): ConversationInput {
  return {
    id: c.id,
    kind: c.kind,
    topic: c.topic,
    lastMessageId: c.lastMessageId,
    lastMessageVersion: c.lastMessageVersion,
    lastMessageTs: c.lastMessageTs,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageFromMe: c.lastMessageFromMe,
    readHorizonTs: c.readTs,
  }
}
