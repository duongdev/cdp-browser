// Reply plumbing for the thread composer (t130, ADR-0019). Mirrors src/lib/slack-reply.ts: the
// reply-target selector is the SINGLE owner of where a reply lands — kept as a seam even though
// Teams chats are flat, so a future threaded surface changes only this. The send-state reducer that
// used to live here retired with the optimistic non-blocking composer (t159): a send appends a
// pending bubble immediately (message-merge.ts resolveLocalSend/markSendFailed) instead of gating
// the input on a phase machine.

import type { TeamsConversation } from "./teams-client"

export interface ReplyTarget {
  convId: string
}

// Teams chats are flat — a reply lands in the conversation itself, never a thread. The seam is
// preserved (a single policy owner) so nothing else encodes reply routing.
export function selectReplyTarget(conv: TeamsConversation): ReplyTarget | null {
  return conv.id ? { convId: conv.id } : null
}
