// Typed client for the Teams chat backend (t106/t107, ADR-0018). The authenticated conversation
// list (`GET /api/teams/conversations`) plus one conversation's history (`POST /api/teams/history`).
// Kept behind this thin seam so t109 (live sync) extends it instead of re-fetching ad hoc.

/** One conversation row as the server's `listConversations` returns it (core/teams-store.js). */
export interface TeamsConversation {
  id: string
  kind: "oneOnOne" | "group"
  topic: string | null
  lastMessageId: string | null
  lastMessageVersion: number
  lastMessageTs: number | null
  lastMessagePreview: string
  muted: boolean
}

interface ConversationsResponse {
  conversations?: TeamsConversation[]
  error?: string
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

export async function fetchConversations(signal?: AbortSignal): Promise<TeamsConversation[]> {
  const res = await fetch("/api/teams/conversations", { signal })
  const data = (await res.json().catch(() => ({}))) as ConversationsResponse
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
  return data.conversations ?? []
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
  error?: string
}

/** One page of a conversation's history, newest-first from the server, oldest-first after render.
 *  `before` (a ts cursor) pages older. Throws TeamsApiError with the server's typed code. */
export async function fetchHistory(convId: string, before?: number): Promise<TeamsMessage[]> {
  const res = await fetch("/api/teams/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ convId, before }),
  })
  const data = (await res.json().catch(() => ({}))) as HistoryResponse
  if (!res.ok || data.error) {
    throw new TeamsApiError(data.error || `http_${res.status}`, res.status)
  }
  return data.messages ?? []
}
