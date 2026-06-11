// Reply plumbing for the Conversation Reader composer (t078, ADR-0012 §3). Two pure
// pieces: the reply-target selector (the SINGLE owner of where a reply lands — the
// user expects this policy to change, so nothing else may encode it) and the composer
// send-state reducer (honest failure: the draft survives, the error is typed). The
// effectful POST lives in conversation-reader.tsx; the server half in web/server.mjs.

import type { ViewEntry } from "./notifications-view"

export interface ReplyTarget {
  channel: string
  thread_ts?: string
}

// Context-dependent policy (the grilled (b) option): DM / group DM → plain message;
// channel mention → that message's thread; thread notification → its parent thread.
// A missing ts degrades to a plain message rather than guessing a thread.
export function selectReplyTarget(entry: ViewEntry): ReplyTarget | null {
  const channel = entry.channelId
  if (!channel) return null
  if (entry.slackKind === "im" || entry.slackKind === "mpim") return { channel }
  if (entry.slackThreadTs) return { channel, thread_ts: entry.slackThreadTs }
  if (entry.slackTs) return { channel, thread_ts: entry.slackTs }
  return { channel }
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
