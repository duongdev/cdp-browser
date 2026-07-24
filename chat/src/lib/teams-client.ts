// Teams chat type home (PSN-93 WS-J). Once the typed fetch client for `/api/teams/*`, now a pure
// type module: the FE talks only to the service-agnostic `/api/chat/*` BFF via `chat-client.ts`,
// which re-exports these `Teams*` shapes. Kept as the single owner of the shared message/conversation
// types (imported `import type` across the component tree); the fetch functions that hit `/api/teams/*`
// were deleted with the legacy routes. `chat-client.ts` mirrors this surface over `/api/chat/*`.

/** One conversation row as the server's `listConversations` returns it (core/teams-store.js). */
export interface TeamsConversation {
  id: string
  /** `self` is the Teams "Notes" chat-with-yourself (id `48:notes`). */
  kind: "oneOnOne" | "group" | "self"
  /** Resolved display title (t131): real member names for a topic-less DM/group-DM, else the
   *  topic. Server-computed and best-effort — absent when name resolution failed. */
  title?: string
  topic: string | null
  lastMessageId: string | null
  lastMessageVersion: number
  lastMessageTs: number | null
  lastMessagePreview: string
  /** The effective read watermark (t155): max(Teams consumptionHorizon, local read), or 0 when a
   *  mark-unread sentinel is set. A conversation is unread when `lastMessageTs > readTs`. */
  readTs: number
  /** True when the last message is the viewer's own send — never badges unread (t155). */
  lastMessageFromMe: boolean
  /** True while an explicit mark-unread sentinel forces the row unread past the Teams horizon (t155). */
  unreadSticky: boolean
  muted: boolean
  /** Local labels applied to this row (t156): set by applyPrefs from the prefs map, not the server
   *  conversation payload. Absent until prefs merge. */
  labels?: string[]
  /** Local folder this row is filed under (t156): set by applyPrefs. null/absent = ungrouped. */
  folder?: string | null
  /** The user oid whose photo represents this row (t153): a 1:1's other member or the self chat's
   *  viewer. Absent for group chats (which keep the initials tile). Feeds `/api/chat/avatar`. */
  avatarUserId?: string
  /** Up to the first few non-self member oids of a group chat (t161) — drives the Teams-style
   *  facepile avatar. Absent for 1:1/self (single avatar) or when the roster is unknown. */
  memberIds?: string[]
  /** Unread @me count (t168) — a floor from locally-synced pages, not Teams' number. Server-set. */
  mentionCount?: number
  /** Local rename (t168): set by applyPrefs from the prefs map; the original title stays visible
   *  as a muted subtitle. Never from the server conversation payload. */
  customTitle?: string
}

/** One page of the conversation list plus the cursor to page older (null = end). */
export interface ConversationsPage {
  conversations: TeamsConversation[]
  cursor: string | null
}

/** A file / call-recording / Swift-card chip parsed from a message (t141). `url` opens in a new tab
 *  (SharePoint files ride the browser's SSO); `thumbnailUrl` is already media-proxied when it's AMS. */
export interface TeamsAttachment {
  kind: "file" | "recording" | "card"
  name?: string
  type?: string
  url?: string
  thumbnailUrl?: string
  title?: string
}

/** One reaction bucket on a message (t142): a named Teams emotion key resolved to a display emoji,
 *  the reactor count, and whether the viewer is one of them. */
export interface TeamsReaction {
  key: string
  emoji: string
  count: number
  mine: boolean
  /** Display names of the OTHER reactors, server-resolved best-effort for the hover tooltip (t143).
   *  Excludes the viewer (shown as "You" when `mine`); absent when none resolved. May be shorter than
   *  `count` — unresolved MRIs are omitted, so the tooltip appends "and N more". */
  reactorNames?: string[]
}

/** One rendered message (server's `teams-render.toReaderMessages` output). `ts` is epoch ms;
 *  `body` is rich site-authored HTML (sanitized at the render boundary). A `kind: "system"` message
 *  (t151) is a meeting/group event line (member add/remove, call ended, rename…) — it carries only
 *  `id`/`ts`/`kind`/`body` (a short plain string) and none of the sender/self/reaction fields. */
export interface TeamsMessage {
  id: string
  ts: number
  /** Present + `"system"` for a system-event line (t151); absent for a normal chat message. */
  kind?: "system"
  senderId?: string
  senderName?: string
  body: string
  self?: boolean
  edited?: boolean
  deleted?: boolean
  /** File / recording / card chips (t141); absent when the message has none. */
  attachments?: TeamsAttachment[]
  /** Reaction chips (t142); absent when the message has none. */
  reactions?: TeamsReaction[]
  /** The viewer is @mentioned in this message (t160) — drives the highlight tint. Server-set. */
  mentionsMe?: boolean
  /** Client-only optimistic image preview (t145): a local object-URL shown until the poll replaces
   *  this message with the server's rendered AMSImage. Never set by the server. */
  localImageUrl?: string
  /** Client-only (t159): an optimistic send still in flight — id is a `local:` placeholder until the
   *  server confirms (resolveLocalSend). Never set by the server. */
  pending?: boolean
  /** Client-only (t159): the typed error code of a failed send — the bubble renders a retry/discard
   *  affordance instead of blocking the composer. Never set by the server. */
  failed?: string
}

/** One page of a conversation's history plus the cursor to page older (null = end, t134). */
export interface HistoryPage {
  messages: TeamsMessage[]
  cursor: string | null
}

/** The server's reply response: `ts` is the sent message's id/arrival-time (epoch ms as string). */
export interface SendReplyResult {
  ok: true
  ts: string
  clientmessageid: string
}

/** One quoted-reply reference sent to the server (t159). */
export interface ReplyRef {
  /** The quoted message's id (epoch ms). */
  messageId: number
  /** The quoted author's bare MRI. */
  sender: string
  /** The quoted message's arrival time (== its id). */
  time: number
}

/** One per-token @mention entry sent to the server (PSN-92 D). */
export interface MentionRef {
  itemid: number
  mri: string
  displayName: string
}

/** A conversation member for the @-mention dropdown (PSN-92 D). */
export interface RosterMember {
  mri: string
  name: string
  /** True for the viewer's own entry — the composer pill uses the coral self-mention style. */
  self?: boolean
}

/** A user's org-directory profile card (t166), server-fetched via Graph `$select`. Every field is
 *  best-effort — empty string / empty array when the directory doesn't carry it. */
export interface TeamsProfile {
  displayName: string
  mail: string
  jobTitle: string
  department: string
  officeLocation: string
  phones: string[]
}

/** Local conversation prefs (t156): labels / folder / mute. Local to the chat store, shared across
 *  devices, never written to Teams. Mirror of the server's teams-store shape. */
export interface ConvPrefsDto {
  labels: string[]
  folder: string | null
  muted: boolean
  /** Timed-mute expiry, epoch ms; null/absent = muted forever while `muted` (t167). */
  mutedUntil?: number | null
  /** Push through the mute when a message @mentions the viewer (t167). */
  notifyOnMention?: boolean
  /** Local rename; null/absent = no rename (t168). */
  customTitle?: string | null
}

export interface PrefsResponse {
  prefs: Record<string, ConvPrefsDto>
  folderOrder: string[]
}
