import type { TeamsConversation } from "./teams-client"

/** Returns true if we should fire a notification for this conversation. */
export function shouldNotifyConv(
  convId: string,
  openConvId: string | null,
  appVisible: boolean,
  muted: boolean,
): boolean {
  if (muted) return false
  // Suppress only when the conversation is BOTH open AND visible
  if (appVisible && openConvId === convId) return false
  return true
}

// Diff two conversation-list polls → conversations whose newest message is a
// fresh *incoming* (not-from-me) one, so the shell can fire a desktop
// Notification. `prev` maps conv id → last-seen `lastMessageTs`. A conversation
// never seen before is only recorded, never notified — that suppresses the
// launch-time flood (the whole list arrives "new" on first poll).
//
// ponytail: a brand-new conversation's first message doesn't notify until its
// second (no prev ts to compare). Acceptable; the alternative needs a separate
// "initialized" flag and still can't tell a new DM from initial load.
export function newlyArrived(
  prev: Map<string, number>,
  next: TeamsConversation[],
): { arrived: TeamsConversation[]; seen: Map<string, number> } {
  const seen = new Map(prev)
  const arrived: TeamsConversation[] = []
  for (const c of next) {
    const ts = c.lastMessageTs ?? 0
    const prevTs = prev.get(c.id)
    seen.set(c.id, ts)
    if (prevTs !== undefined && ts > prevTs && !c.lastMessageFromMe) arrived.push(c)
  }
  return { arrived, seen }
}
