// Conversation Reader tap routing (t077, ADR-0012). Pure: decides how a notification
// renders in the reader — a real message view from sweep history, or the stub detail
// (the captured toast text) — via a per-adapter capability table, never an inline
// Slack branch. The effectful fetch lives in the component; the server endpoint in
// web/server.mjs (Electron has no sweep, so the bridge method is absent → stub).

import type { ViewEntry } from "./notifications-view"
import { excludeTargetFromEntry } from "./slack-excludes"

export type ReaderRoute = { kind: "history"; team: string; channel: string } | { kind: "stub" }

// Per-adapter reader capability. Adding a content backend for another adapter is one
// entry here (plus its fetch path) — tap routing is unchanged.
const READER_CAPABILITY: Record<string, "history"> = {
  slack: "history",
}

export function readerRoute(entry: ViewEntry, hasHistoryBridge: boolean): ReaderRoute {
  if (!hasHistoryBridge) return { kind: "stub" }
  if (READER_CAPABILITY[entry.adapter ?? ""] !== "history") return { kind: "stub" }
  // The same {team, channelId} derivation the Channel Exclude action uses — null for
  // entries that don't carry a stable channel identity (pre-sweep hijack backlog).
  const target = excludeTargetFromEntry(entry)
  if (!target) return { kind: "stub" }
  return { kind: "history", team: target.team, channel: target.channelId }
}
