// Service-agnostic chat contract (PSN-93, Workstream A). The FE imports these types; the BFF
// serves them. Designed to be a faithful generic lift of today's Teams shapes
// (chat/src/lib/teams-client.ts) so nothing regresses when `teams-client.ts` becomes
// `chat-client.ts` — every field the Teams client carries has a home here.
//
// `service` is the discriminator. It's `"teams"` today and left string-open so a second provider
// (Slack, …) is purely additive — no field is Teams-specific in name.

/** The chat provider a conversation/message belongs to. `"teams"` first; string-open for future
 *  providers so a second service plugs in without a schema/type change. */
export type ChatService = "teams" | (string & {})

/** A conversation's structural kind. `self` is the "chat with yourself" thread (Teams `48:notes`);
 *  `oneOnOne` a DM; `group` a group chat / channel. */
export type ChatConversationKind = "self" | "oneOnOne" | "group"

/** One conversation row. Generic lift of `TeamsConversation`. */
export interface ChatConversation {
  service: ChatService
  id: string
  kind: ChatConversationKind
  /** Resolved display title: real member names for a topic-less DM/group, else the topic.
   *  Best-effort — absent when name resolution failed. */
  title?: string
  /** The provider-native topic (a group's set name), null when none. */
  topic: string | null
  lastMessageId: string | null
  lastMessageVersion: number
  lastMessageTs: number | null
  lastMessagePreview: string
  /** Effective read watermark: max(provider read horizon, local read), or just below the
   *  mark-unread bookmark when one is set. A conversation is unread when `lastMessageTs > readTs`. */
  readTs: number
  /** The provider's mark-unread bookmark ts; 0 = not marked unread. Read state is shared with the
   *  service (PSN-102), and a read watermark can only move forward — so "unread again" needs this
   *  separate, freely-rewritable marker. */
  unreadBookmarkTs?: number
  /** True when the last message is the viewer's own send — never badges unread. */
  lastMessageFromMe: boolean
  /** True while an explicit mark-unread bookmark forces the row unread past the read watermark. */
  unreadSticky: boolean
  muted: boolean
  /** Local labels applied to this row (from prefs, not the provider payload). */
  labels?: string[]
  /** Local folder this row is filed under (from prefs). null/absent = ungrouped. */
  folder?: string | null
  /** The user id whose photo represents this row: a 1:1's other member or the self chat's viewer.
   *  Absent for group chats (initials tile). Feeds `/api/chat/avatar`. */
  avatarUserId?: string
  /** Up to the first few non-self member ids of a group chat — drives the facepile avatar. */
  memberIds?: string[]
  /** Unread @me count — a floor from locally-synced pages, not the provider's number. */
  mentionCount?: number
  /** Local rename; the original title stays visible as a muted subtitle. */
  customTitle?: string
}

/** A file / call-recording / card chip parsed from a message. Generic lift of `TeamsAttachment`. */
export interface ChatAttachment {
  kind: "file" | "recording" | "card"
  name?: string
  type?: string
  /** Opens in a new tab (provider SSO). */
  url?: string
  /** Already media-proxied when the source is provider-hosted (e.g. Teams AMS). */
  thumbnailUrl?: string
  title?: string
}

/** One reaction bucket on a message. Generic lift of `TeamsReaction`. */
export interface ChatReaction {
  /** The provider-native reaction key (e.g. a Teams emotion key). */
  key: string
  /** The display glyph resolved from `key`. */
  emoji: string
  count: number
  /** The viewer is one of the reactors. */
  mine: boolean
  /** Display names of the OTHER reactors, best-effort for the hover tooltip. May be shorter than
   *  `count` — unresolved ids are omitted (the tooltip appends "and N more"). */
  reactorNames?: string[]
}

/** One rendered message. Generic lift of `TeamsMessage`. `ts` is epoch ms; `body` is rich HTML
 *  sanitized at the render boundary. A `kind: "system"` message carries only id/ts/kind/body. */
export interface ChatMessage {
  service: ChatService
  id: string
  ts: number
  /** Present + `"system"` for a system-event line; absent for a normal chat message. */
  kind?: "system"
  senderId?: string
  senderName?: string
  body: string
  self?: boolean
  edited?: boolean
  deleted?: boolean
  attachments?: ChatAttachment[]
  reactions?: ChatReaction[]
  /** The viewer is @mentioned in this message — drives the highlight tint. */
  mentionsMe?: boolean
  // ---- client-only optimistic fields (never set by the server) ----
  /** A local object-URL image preview shown until the sweep replaces this with the rendered upload. */
  localImageUrl?: string
  /** An optimistic send still in flight — id is a `local:` placeholder until the server confirms. */
  pending?: boolean
  /** The typed error code of a failed send — the bubble renders retry/discard instead of blocking. */
  failed?: string
}

/** A user's org-directory profile card. Generic lift of `TeamsProfile`; every field best-effort. */
export interface ChatProfile {
  displayName: string
  mail: string
  jobTitle: string
  department: string
  officeLocation: string
  phones: string[]
}

/** Per-conversation LOCAL prefs: labels / folder / mute. Local to the BFF store, shared across
 *  devices, never written back to the provider. Generic lift of `ConvPrefsDto`. */
export interface ChatPrefs {
  labels: string[]
  folder: string | null
  muted: boolean
  /** Timed-mute expiry, epoch ms; null/absent = muted forever while `muted`. */
  mutedUntil?: number | null
  /** Push through the mute when a message @mentions the viewer. */
  notifyOnMention?: boolean
  /** Local rename; null/absent = no rename. */
  customTitle?: string | null
}

/** A conversation member for the @-mention dropdown. Generic lift of `RosterMember`. */
export interface RosterMember {
  /** The member's provider id (Teams: MRI). */
  id: string
  name: string
  /** True for the viewer's own entry. */
  self?: boolean
}

/** A quoted message the composer is replying to. Generic lift of `ReplyRef`. */
export interface ReplyRef {
  messageId: number
  /** The quoted author's provider id. */
  sender: string
  time: number
}

/** One per-token @mention entry sent with a reply. Generic lift of `MentionRef`. */
export interface MentionRef {
  itemid: number
  /** The mentioned user's provider id. */
  id: string
  displayName: string
}

/** One page of the conversation list plus the cursor to page older (null = end). */
export interface ConversationsPage {
  conversations: ChatConversation[]
  cursor: string | null
}

/** One page of a conversation's history plus the cursor to page older (null = end). */
export interface HistoryPage {
  messages: ChatMessage[]
  cursor: string | null
}

/** A DB-served jump window (t175): `POST /history` with `aroundMsgId` / `afterTs` / `beforeTs`
 *  serves from the store (no provider cursor). `missing` = the target isn't synced — honest
 *  fallback, the client opens at newest with a notice. */
export interface HistoryWindow {
  messages: ChatMessage[]
  missing?: boolean
  hasOlder?: boolean
  hasNewer?: boolean
}

/** The reply response: `ts` is the sent message's id/arrival time (epoch ms as string). */
export interface SendResult {
  ok: true
  ts: string
  clientMessageId: string
}

/** All conversations' prefs → a map keyed by convId, plus the folder display order. */
export interface PrefsResponse {
  prefs: Record<string, ChatPrefs>
  folderOrder: string[]
}

/**
 * REST route contract — `/api/chat/*` (served by the BFF, reverse-proxied through the one public
 * origin). Types above are the payloads; handlers land in later workstreams (B–H). Every request
 * carries `service` (body field or query) so the BFF routes to the right provider.
 *
 *   POST /api/chat/conversations   { service, cursor? }              → ConversationsPage
 *   POST /api/chat/history         { service, convId, cursor?, poll? } → HistoryPage
 *   POST /api/chat/reply           { service, convId, text, html?, quotes?, mentions? } → SendResult
 *   POST /api/chat/react           { service, convId, msgId, key, remove } → { ok }
 *   POST /api/chat/edit            { service, convId, msgId, text }   → { ok }
 *   POST /api/chat/delete          { service, convId, msgId }         → { ok }
 *   POST /api/chat/roster          { service, convId }                → { members: RosterMember[] }
 *   POST /api/chat/upload-image    { service, convId, filename, base64, contentType, width, height, text? } → { ok, msgId }
 *   POST /api/chat/upload-images   { service, convId, images[], text? } → { ok, msgId }
 *   POST /api/chat/upload-file     { service, convId, filename, base64, contentType, text? } → { ok, msgId }
 *   GET  /api/chat/profile         ?service&userId                    → { profile: ChatProfile }
 *   GET  /api/chat/avatar          ?service&userId                    → image bytes
 *   GET  /api/chat/media           ?service&url                       → media bytes (proxied)
 *   GET  /api/chat/prefs           ?service                           → PrefsResponse
 *   POST /api/chat/prefs           { service, convId?, ...patch | folderOrder } → { prefs?, folderOrder? }
 *   POST /api/chat/mark-read       { service, convId, msgId, ts }     → { ok } (write-through to provider)
 *   POST /api/chat/mark-unread     { service, convId, ts }            → { ok } (write-through to provider)
 *   POST /api/chat/backfill        { service, action: "start", days } → { ok } (start a run)
 *   GET  /api/chat/backfill        ?service                           → BackfillStatus (poll fallback; live over WS)
 *
 * All endpoints return `{ error: code }` with a non-2xx status on failure (typed codes, e.g.
 * `invalid_auth`), matching today's Teams client error contract.
 */
export interface BackfillStatus {
  running: boolean
  /** The requested window, in days. */
  days: number
  conversationsDone: number
  conversationsTotal: number
  messagesFetched: number
  /** A typed error code if the run aborted (e.g. a 429 storm); absent while healthy. */
  error?: string
}

/**
 * WS protocol — `/api/chat/ws` (same origin, auth-less). The client sends `{ focus: convId | null }`
 * to steer the fast-sweep; the server pushes a snapshot on connect then deltas. Every server frame
 * is one of these tagged kinds.
 */
export type ChatWsClientMessage = { type: "focus"; convId: string | null }

export type ChatWsServerMessage =
  | { type: "conversation-upsert"; service: ChatService; conversations: ChatConversation[] }
  | { type: "messages-upsert"; service: ChatService; convId: string; messages: ChatMessage[] }
  | {
      type: "read-state"
      service: ChatService
      convId: string
      readTs: number
      unreadSticky: boolean
    }
  | { type: "backfill-progress"; service: ChatService; status: BackfillStatus }
  | { type: "health"; service: ChatService; ok: boolean; code?: string }

/**
 * Assistant contract (t173, ADR-0021). Sessions live under `/api/chat/assistant`:
 * GET/POST `/sessions`, PATCH/DELETE `/sessions/:id`, GET `/sessions/:id/messages`,
 * POST `/sessions/:id/context` (attach a ref), POST `/:sessionId` (the useChat stream route,
 * returns a UI message stream). Errors are `{ error: code }` — `llm-unconfigured` (503),
 * `llm-rate-limited`, `llm-timeout`, `llm-error`, `not_found`.
 */
/** An attachment on a session. `chat`/`message` point at ids; `folder`/`label` (PSN-104) point at
 *  a NAME and resolve to conversations at question time, so they stay live as membership changes. */
export interface AssistantContextRef {
  service: ChatService
  kind: "chat" | "message" | "folder" | "label"
  convId?: string
  msgId?: string
  /** folder/label only. */
  name?: string
  title: string
  sender?: string
  preview?: string
  deepLink: string
}

export interface AssistantSession {
  id: string
  title: string | null
  /** Per-session model override (t177); null = env default. */
  model: string | null
  createdAt: number
  updatedAt: number
  summary: string | null
  summaryUptoIdx: number
  totalTokens: number
  contextRefs: AssistantContextRef[]
}

/** A validated citation stored on an assistant message's metadata (decision 3). */
export interface AssistantCitation {
  convId: string
  msgId: string
}
