// Typed client for the Teams chat backend (t106, ADR-0018). One call for now — the
// authenticated conversation list from `GET /api/teams/conversations`. Kept behind this
// thin seam so t107 (thread read) + t109 (live sync) extend it instead of re-fetching ad hoc.

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
