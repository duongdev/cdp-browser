// Reply plumbing for the thread composer (t130, ADR-0019). Mirrors src/lib/slack-reply.ts:
// the reply-target selector (the SINGLE owner of where a reply lands — kept as a seam even
// though Teams chats are flat, so a future threaded surface changes only this) and the composer
// send-state reducer (honest failure: the draft survives, the error is typed). The effectful
// POST lives in thread-view.tsx; the server half is POST /api/teams/reply in web/server.mjs.

import type { TeamsConversation } from "./teams-client"

export interface ReplyTarget {
  convId: string
}

// Teams chats are flat — a reply lands in the conversation itself, never a thread. The seam is
// preserved (a single policy owner) so nothing else encodes reply routing.
export function selectReplyTarget(conv: TeamsConversation): ReplyTarget | null {
  return conv.id ? { convId: conv.id } : null
}

export type SendState =
  | { phase: "idle"; draft: string }
  | { phase: "sending"; draft: string }
  | { phase: "failed"; draft: string; code: string }

export type SendEvent =
  | { type: "edit"; draft: string }
  | { type: "send" }
  | { type: "ok" }
  | { type: "fail"; code: string }

export function reduceSend(state: SendState, event: SendEvent): SendState {
  switch (event.type) {
    case "edit":
      return { phase: "idle", draft: event.draft }
    case "send":
      if (state.phase === "sending" || !state.draft.trim()) return state
      return { phase: "sending", draft: state.draft }
    case "ok":
      return { phase: "idle", draft: "" }
    case "fail":
      return { phase: "failed", draft: state.draft, code: event.code }
  }
}
