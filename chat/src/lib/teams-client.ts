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

/** A file / call-recording / Swift-card chip parsed from a message (t119). `url` opens in a new tab
 *  (SharePoint files ride the browser's SSO); `thumbnailUrl` is already media-proxied when it's AMS. */
export interface TeamsAttachment {
  kind: "file" | "recording" | "card"
  name?: string
  type?: string
  url?: string
  thumbnailUrl?: string
  title?: string
}

/** One reaction bucket on a message (t120): a named Teams emotion key resolved to a display emoji,
 *  the reactor count, and whether the viewer is one of them. */
export interface TeamsReaction {
  key: string
  emoji: string
  count: number
  mine: boolean
  /** Display names of the OTHER reactors, server-resolved best-effort for the hover tooltip (t121).
   *  Excludes the viewer (shown as "You" when `mine`); absent when none resolved. May be shorter than
   *  `count` — unresolved MRIs are omitted, so the tooltip appends "and N more". */
  reactorNames?: string[]
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
  /** File / recording / card chips (t119); absent when the message has none. */
  attachments?: TeamsAttachment[]
  /** Reaction chips (t120); absent when the message has none. */
  reactions?: TeamsReaction[]
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

/** Add (`remove` false) or remove (`remove` true) the viewer's reaction on a message (t120). The
 *  server PUT/DELETEs the emotions property IN-PAGE. Best-effort like `markRead` — the optimistic UI
 *  already updated and the next poll reconciles, so a failure here is swallowed. */
export async function react(
  convId: string,
  msgId: string,
  key: string,
  remove: boolean,
): Promise<void> {
  try {
    await fetch("/api/teams/react", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId, msgId, key, remove }),
    })
  } catch {
    // best-effort: the optimistic chip stands until the next poll reconciles
  }
}

/** Edit the viewer's own message text (t122). The server PUTs the new RichText/Html content IN-PAGE.
 *  Throws TeamsApiError with the server's typed code on failure so the editor can keep the draft +
 *  show honest copy (like `sendReply`); the optimistic edit + next poll otherwise reconcile. */
export async function editMessage(convId: string, msgId: string, text: string): Promise<void> {
  const res = await fetch("/api/teams/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ convId, msgId, text }),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: true; error?: string }
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
}

/** Delete the viewer's own message (t122). The server DELETEs it IN-PAGE, leaving Teams' tombstone.
 *  Throws TeamsApiError on failure so the UI can react; the optimistic tombstone + next poll's
 *  server-wins merge otherwise reconcile (a failed delete restores the message). */
export async function deleteMessage(convId: string, msgId: string): Promise<void> {
  const res = await fetch("/api/teams/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ convId, msgId }),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: true; error?: string }
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
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
