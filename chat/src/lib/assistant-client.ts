// The /api/chat/assistant client (t174, ADR-0021). Session CRUD + message load; the streamed chat
// itself rides @ai-sdk/react useChat's DefaultChatTransport straight at the same base. Errors are
// the typed `{ error: code }` contract (t173).

export interface AssistantContextRef {
  service: string
  /** "chat" = whole conversation, "message" = one message (+ its window), "folder"/"label" = one of
   *  the user's own groupings, resolved to conversations at question time (PSN-104) so a chat filed
   *  into it later is in scope without re-attaching. */
  kind: "chat" | "message" | "folder" | "label"
  /** chat/message only. */
  convId?: string
  msgId?: string
  /** folder/label only: the scope's name. */
  name?: string
  /** Conversation title, or the folder/label name. */
  title: string
  /** Message refs only — who said it + a short excerpt, so chips from one chat differ. */
  sender?: string
  preview?: string
  deepLink: string
}

/** The user's own groupings, offered as attachable scopes. Mirrors the server's `Scopes`, but the
 *  FE derives it from the prefs it already holds — no extra fetch. */
export interface AssistantScopes {
  folders: { name: string; count: number }[]
  labels: { name: string; count: number }[]
}

/** Identity of an attachment, mirroring the server: a scope by (kind, name), else (convId, msgId).
 *  Used for optimistic add/remove in the tray. */
export function refKey(ref: {
  kind?: string
  name?: string
  convId?: string
  msgId?: string
}): string {
  return ref.kind === "folder" || ref.kind === "label"
    ? `scope\n${ref.kind}\n${ref.name}`
    : `msg\n${ref.convId ?? ""}\n${ref.msgId ?? ""}`
}

/** A scope ref carries a name instead of ids — the one branch every consumer needs. */
export function isScopeRef(
  ref: AssistantContextRef,
): ref is AssistantContextRef & { kind: "folder" | "label"; name: string } {
  return ref.kind === "folder" || ref.kind === "label"
}

export interface AssistantSession {
  id: string
  title: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  summary: string | null
  summaryUptoIdx: number
  totalTokens: number
  contextRefs: AssistantContextRef[]
}

export const ASSISTANT_BASE = "/api/chat/assistant"

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${ASSISTANT_BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(j?.error || `http_${r.status}`)
  return j
}

export async function listSessions(): Promise<AssistantSession[]> {
  return (await req<{ sessions: AssistantSession[] }>("/sessions")).sessions
}

export async function createSession(opts: { title?: string; model?: string } = {}) {
  return (
    await req<{ session: AssistantSession }>("/sessions", {
      method: "POST",
      body: JSON.stringify(opts),
    })
  ).session
}

export async function patchSession(id: string, patch: { title?: string; model?: string }) {
  return (
    await req<{ session: AssistantSession }>(`/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  ).session
}

export async function deleteSession(id: string): Promise<void> {
  await req(`/sessions/${id}`, { method: "DELETE" })
}

/** Stored UIMessages for a session (the useChat initial state on open). */
export async function loadSessionMessages(id: string) {
  return req<{ session: AssistantSession; messages: unknown[] }>(`/sessions/${id}/messages`)
}

export type AttachTarget =
  | {
      service?: string
      convId: string
      msgId?: string
      title: string
      sender?: string
      preview?: string
      deepLink?: string
    }
  | { service?: string; kind: "folder" | "label"; name: string }

export async function attachContext(id: string, ref: AttachTarget) {
  return (
    await req<{ session: AssistantSession }>(`/sessions/${id}/context`, {
      method: "POST",
      body: JSON.stringify(ref),
    })
  ).session
}

/** Detach a ref by (convId, msgId) or, for a scope, by (kind, name). The target rides the query
 *  string — a DELETE body isn't reliably forwarded through proxies. */
export async function detachContext(
  id: string,
  target: { convId?: string; msgId?: string; kind?: string; name?: string },
): Promise<AssistantSession> {
  const q = new URLSearchParams()
  if (target.name && (target.kind === "folder" || target.kind === "label")) {
    q.set("kind", target.kind)
    q.set("name", target.name)
  } else if (target.convId) q.set("convId", target.convId)
  if (target.msgId) q.set("msgId", target.msgId)
  return (
    await req<{ session: AssistantSession }>(`/sessions/${id}/context?${q}`, { method: "DELETE" })
  ).session
}

/** A curated model row (t177) — from LLM_MODELS, never the raw router dump. */
export interface AssistantModel {
  id: string
  label: string
  default: boolean
  /** The model's real context window in tokens, when the provider reports one. */
  contextWindow?: number
  maxOutput?: number
}

export async function listModels(): Promise<AssistantModel[]> {
  return (await req<{ models: AssistantModel[] }>("/models")).models
}

/** The draft-reply tone guidance blob (t176) — DB-stored, user-editable, empty = none. */
export async function getAssistantVoice(): Promise<string> {
  try {
    return (await req<{ voice: string }>("/prefs")).voice ?? ""
  } catch {
    return ""
  }
}

export async function setAssistantVoice(voice: string): Promise<void> {
  await req("/prefs", { method: "POST", body: JSON.stringify({ voice }) })
}

/** Typed error code → user copy (four-state error coverage, t174). */
export function assistantErrorCopy(code: string | undefined): string {
  switch (code) {
    case "llm-unconfigured":
      return "No AI model is configured. Set LLM_BASE_URL / LLM_MODEL on the chat server."
    case "llm-rate-limited":
      return "The model is rate-limited right now. Try again in a moment."
    case "llm-timeout":
      return "The model timed out. Try again."
    case "not_found":
      return "This session no longer exists."
    default:
      return "Something went wrong talking to the model."
  }
}

/** Extract our typed code from a thrown/streamed error (the stream's onError emits the bare code). */
export function assistantErrorCode(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? "")
  const known = ["llm-unconfigured", "llm-rate-limited", "llm-timeout", "not_found", "llm-error"]
  return known.find((k) => msg.includes(k)) ?? "llm-error"
}
