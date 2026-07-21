// Typed client for the Teams chat backend (t106/t107, ADR-0018). The authenticated conversation
// list (`GET /api/teams/conversations`) plus one conversation's history (`POST /api/teams/history`).
// Kept behind this thin seam so t109 (live sync) extends it instead of re-fetching ad hoc.

/** One conversation row as the server's `listConversations` returns it (core/teams-store.js). */
export interface TeamsConversation {
  id: string
  /** `self` is the Teams "Notes" chat-with-yourself (id `48:notes`). */
  kind: "oneOnOne" | "group" | "self"
  /** Resolved display title (t109): real member names for a topic-less DM/group-DM, else the
   *  topic. Server-computed and best-effort — absent when name resolution failed. */
  title?: string
  topic: string | null
  lastMessageId: string | null
  lastMessageVersion: number
  lastMessageTs: number | null
  lastMessagePreview: string
  muted: boolean
}

interface ConversationsResponse {
  conversations?: TeamsConversation[]
  /** Opaque backwardLink for the next older page; null when there are no more (t112). */
  cursor?: string | null
  error?: string
}

/** One page of the conversation list plus the cursor to page older (null = end). */
export interface ConversationsPage {
  conversations: TeamsConversation[]
  cursor: string | null
}

/** A failed conversation fetch, carrying the server's typed code (e.g. `invalid_auth`). */
export class TeamsApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code)
    this.name = "TeamsApiError"
  }
}

/** One page of the conversation list (t112). No `cursor` → the newest page; a `cursor` (the prior
 *  page's backwardLink) → the next older page. Returns the page + the next cursor (null = end). */
export async function fetchConversations(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<ConversationsPage> {
  const res = await fetch("/api/teams/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cursor ? { cursor } : {}),
    signal,
  })
  const data = (await res.json().catch(() => ({}))) as ConversationsResponse
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
  return { conversations: data.conversations ?? [], cursor: data.cursor ?? null }
}

/** One rendered message (server's `teams-render.toReaderMessages` output). `ts` is epoch ms;
 *  `body` is already sanitized plain text — the view renders it as a text node, never innerHTML. */
export interface TeamsMessage {
  id: string
  ts: number
  senderId: string
  senderName: string
  body: string
  self: boolean
  edited: boolean
  deleted: boolean
}

interface HistoryResponse {
  messages?: TeamsMessage[]
  /** Opaque backwardLink for the next older page; null when there are no more (t112). */
  cursor?: string | null
  error?: string
}

/** One page of a conversation's history plus the cursor to page older (null = end, t112). */
export interface HistoryPage {
  messages: TeamsMessage[]
  cursor: string | null
}

/** One page of a conversation's history, oldest-first after render. No `cursor` → the newest page;
 *  a `cursor` (the prior page's backwardLink) → the next older page. Throws TeamsApiError with the
 *  server's typed code. */
export async function fetchHistory(convId: string, cursor?: string | null): Promise<HistoryPage> {
  const res = await fetch("/api/teams/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cursor ? { convId, cursor } : { convId }),
  })
  const data = (await res.json().catch(() => ({}))) as HistoryResponse
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
  return { messages: data.messages ?? [], cursor: data.cursor ?? null }
}

/** The server's reply response: `ts` is the sent message's id/arrival-time (epoch ms as string). */
export interface SendReplyResult {
  ok: true
  ts: string
  clientmessageid: string
}

/** Send a text reply to a conversation (t108). Throws TeamsApiError with the server's typed code
 *  on failure so the composer can retain the draft and show honest copy. */
export async function sendReply(convId: string, text: string): Promise<SendReplyResult> {
  const res = await fetch("/api/teams/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ convId, text }),
  })
  const data = (await res.json().catch(() => ({}))) as SendReplyResult & { error?: string }
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
  return data
}

/** Write-through mark-read (t108, Q9 hybrid): push the conversation's read horizon to Teams.
 *  Best-effort — the server never fails this, and a network error here must never surface, so
 *  it swallows everything. Called after a successful reply (and on an explicit mark-read). */
export async function markRead(convId: string, msgId: string, ts: string): Promise<void> {
  try {
    await fetch("/api/teams/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId, msgId, ts }),
    })
  } catch {
    // best-effort: the desktop unread just survives as a to-do trail
  }
}
