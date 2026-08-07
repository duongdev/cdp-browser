// The provider seam (PSN-93, Workstream B). A `ChatProvider` is the BFF's only door to a chat
// service's live data. `TeamsProvider` speaks server.mjs's `/internal/teams/*`; `MockProvider`
// speaks in-memory fixtures for hermetic tests. A future service (Slack, …) is a third
// implementation — the sweep/routes never learn a provider's transport.
//
// Every method returns the service-agnostic contract types (from `../contract`); the provider is
// responsible for stamping `service`. Prefs are LOCAL to the BFF store and are NOT on
// this interface — the store owns them.

import type {
  ChatConversation,
  ChatMessage,
  ChatProfile,
  ChatService,
  ConversationsPage,
  HistoryPage,
  MentionRef,
  ReplyRef,
  RosterMember,
  SendResult,
} from "../contract.ts"

/** Raw bytes plus content-type, for the media/avatar proxies. */
export interface MediaBytes {
  contentType: string
  body: Uint8Array
}

/** An avatar result: bytes, or `miss` when the user has no photo (the FE keeps initials). */
export type AvatarResult = MediaBytes | { miss: true }

/** One image in a multi-image upload. */
export interface UploadImage {
  filename: string
  base64: string
  contentType?: string
  width?: number
  height?: number
}

/** Quotes/mentions that ride along with an upload send (t182). Mirrors the reply path's opts so an
 *  attachment can carry a quoted reply and real @mentions instead of silently dropping both. `html`
 *  is the composer's pre-built rich caption — it is sent VERBATIM, which is the only way per-token
 *  mention spans survive to the wire. */
export interface UploadOpts {
  text?: string
  html?: string | null
  quotes?: ReplyRef[]
  mentions?: MentionRef[]
}

/** The result of an upload send: the new message's id (arrival ms as string). */
export interface UploadResult {
  ok: true
  msgId: string
}

/**
 * One raw provider-level search hit (PSN-115 WS-A). This is the *upstream-native* shape straight
 * from the provider's search API (Teams Substrate today). The BFF's `/api/chat/search` route is
 * responsible for fusing these with local FTS rows and producing the merged `SearchHit` in
 * `contract.ts` (which adds `source`/`hydrated`/`convTitle`/`snippet`). Keep them distinct so the
 * provider never has to know about local DB state.
 */
export interface ProviderSearchHit {
  convId: string
  msgId: string
  preview: string
  sender: string
  ts: number
  subject: string
  /** Provider-native class discriminator (Teams `IPM.SkypeTeams.Message`). Useful for diagnostics. */
  itemClass?: string
}

/** One page of provider-level search results. `cursor` is opaque to the caller; null = end. */
export interface ProviderSearchPage {
  rows: ProviderSearchHit[]
  cursor: string | null
  total: number
}

/** A typed provider failure carrying the upstream error `code` (e.g. `invalid_auth`) + HTTP status.
 *  Routes surface `code` to the FE unchanged, matching today's Teams error contract. */
export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
  ) {
    super(code)
    this.name = "ProviderError"
  }
}

export interface ChatProvider {
  /** The service this provider serves, stamped onto every returned row. */
  readonly service: ChatService

  listConversations(cursor?: string | null): Promise<ConversationsPage>
  fetchHistory(convId: string, cursor?: string | null, poll?: boolean): Promise<HistoryPage>
  sendReply(
    convId: string,
    text: string,
    opts?: { html?: string | null; quotes?: ReplyRef[]; mentions?: MentionRef[] },
  ): Promise<SendResult>
  react(convId: string, msgId: string, key: string, remove: boolean): Promise<void>
  edit(convId: string, msgId: string, text: string): Promise<void>
  delete(convId: string, msgId: string): Promise<void>
  markRead(convId: string, msgId: string, ts: number): Promise<void>
  /** Flag the conversation unread from `ts` on, service-side (PSN-102). */
  markUnread(convId: string, ts: number): Promise<void>
  roster(convId: string): Promise<RosterMember[]>
  uploadImage(convId: string, image: UploadImage, opts?: UploadOpts): Promise<UploadResult>
  uploadImages(convId: string, images: UploadImage[], opts?: UploadOpts): Promise<UploadResult>
  uploadFile(
    convId: string,
    file: { filename: string; base64: string; contentType?: string },
    opts?: UploadOpts,
  ): Promise<UploadResult>
  profile(userId: string): Promise<ChatProfile>
  avatar(userId: string, size?: string): Promise<AvatarResult>
  media(url: string): Promise<MediaBytes>
  /**
   * Server-side search via the provider's native search API (PSN-115 WS-A — Teams Substrate today).
   * Returns raw provider-level hits; the BFF's `/api/chat/search` route (WS-D) is responsible for
   * fusing these with local FTS rows + scope filters + conv-title hydration before surfacing to the
   * FE. `sort` is a hint — a provider that doesn't distinguish sorts still returns its native order.
   * `cursor` is opaque to the caller; null/undefined = first page, null back = end.
   */
  searchMessages(
    query: string,
    opts?: { sort?: "relevance" | "recent"; cursor?: string | null },
  ): Promise<ProviderSearchPage>
}

/** Re-export the contract row types callers touch, so a provider consumer imports from one place. */
export type { ChatConversation, ChatMessage }
