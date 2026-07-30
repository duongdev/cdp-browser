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

// How many dropped filenames to spell out before summarising the rest.
const MAX_NAMED_FAILURES = 3

// Copy for a PARTIAL attachment send — some files landed, these didn't. This case can't be shown on
// the bubble: the bubble stands for the files that DID send, and marking it failed would re-send
// those on retry. A toast is the only honest channel, and it has to name what was lost or the user
// reads a partial send as a clean one (PSN-121, where this was a bare console.warn). Returns "" when
// nothing failed, so the caller can treat empty as "say nothing".
export function partialSendMessage(failedNames: readonly string[]): string {
  const names = failedNames.filter((n) => n?.trim())
  if (names.length === 0) return ""
  const noun = names.length === 1 ? "attachment" : "attachments"
  const rest = names.length - MAX_NAMED_FAILURES
  const shown = names.slice(0, MAX_NAMED_FAILURES).join(", ")
  const tail = rest > 0 ? `${shown} and ${rest} more` : shown
  return `${names.length} ${noun} failed to send: ${tail}. The rest were sent.`
}
