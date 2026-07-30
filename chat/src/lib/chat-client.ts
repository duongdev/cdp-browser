// Typed client for the chat BFF (PSN-93, Workstream E). Same surface as `teams-client.ts` but hits
// the service-agnostic `/api/chat/*` contract (apps/chat-server/src/contract.ts) instead of
// `/api/teams/*`, carrying a `service` discriminator (default "teams"). Only the READ methods get
// consumers this workstream; the WRITE methods are ported so WS-F only rewires call sites.
//
// It returns the existing `Teams*` shapes (re-exported from teams-client.ts) — the contract's
// `Chat*` types are field-identical minus a `service` tag the components never read — so nothing has
// to rename across the component tree. `ChatApiError` mirrors `TeamsApiError` (typed code + status).

import type {
  MentionRef,
  ReplyRef,
  RosterMember,
  TeamsConversation,
  TeamsMessage,
  TeamsProfile,
} from "./teams-client"

/** The chat service a request targets. "teams" today; string-open so a second provider is additive. */
export type ChatService = "teams" | (string & {})

const SERVICE: ChatService = "teams"

/** A failed BFF call, carrying the server's typed code (e.g. `invalid_auth`). Mirrors TeamsApiError. */
export class ChatApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code)
    this.name = "ChatApiError"
  }
}

/** POST a JSON body to `/api/chat/{path}`, throwing ChatApiError on a non-2xx or `{ error }` body. */
async function post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/chat/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: SERVICE, ...body }),
    signal,
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok || data.error) throw new ChatApiError(data.error || `http_${res.status}`, res.status)
  return data
}

export interface ConversationsPage {
  conversations: TeamsConversation[]
  cursor: string | null
}

/** One page of the conversation list. No `cursor` → newest page; a `cursor` → the next older page. */
export async function fetchConversations(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<ConversationsPage> {
  const data = await post<{ conversations?: TeamsConversation[]; cursor?: string | null }>(
    "conversations",
    cursor ? { cursor } : {},
    signal,
  )
  return { conversations: data.conversations ?? [], cursor: data.cursor ?? null }
}

export interface HistoryPage {
  messages: TeamsMessage[]
  cursor: string | null
}

/** One page of a conversation's history. `poll` marks a background refresh of an open thread (the
 *  server then won't let its local-read write clear a mark-unread sentinel). */
export async function fetchHistory(
  convId: string,
  cursor?: string | null,
  poll?: boolean,
): Promise<HistoryPage> {
  const data = await post<{ messages?: TeamsMessage[]; cursor?: string | null }>("history", {
    convId,
    ...(cursor ? { cursor } : {}),
    ...(poll ? { poll: true } : {}),
  })
  return { messages: data.messages ?? [], cursor: data.cursor ?? null }
}

/** A DB-served jump window (t175) — see HistoryWindow in the BFF contract. `missing` = the target
 *  message isn't synced; the caller falls back honestly. */
export interface HistoryWindow {
  messages: TeamsMessage[]
  missing?: boolean
  hasOlder?: boolean
  hasNewer?: boolean
}

export async function fetchHistoryAround(convId: string, msgId: string): Promise<HistoryWindow> {
  return post<HistoryWindow>("history", { convId, aroundMsgId: msgId })
}

export async function fetchHistoryAfter(convId: string, afterTs: number): Promise<HistoryWindow> {
  return post<HistoryWindow>("history", { convId, afterTs })
}

export async function fetchHistoryBefore(convId: string, beforeTs: number): Promise<HistoryWindow> {
  return post<HistoryWindow>("history", { convId, beforeTs })
}

/** Local conversation prefs: labels / folder / mute. Local to the BFF store, shared across devices. */
export interface ConvPrefsDto {
  labels: string[]
  folder: string | null
  muted: boolean
  mutedUntil?: number | null
  notifyOnMention?: boolean
  customTitle?: string | null
}

export interface PrefsResponse {
  prefs: Record<string, ConvPrefsDto>
  folderOrder: string[]
}

/** All conversations' prefs → a map keyed by convId. Null on failure — callers keep current state. */
export async function fetchPrefs(signal?: AbortSignal): Promise<PrefsResponse | null> {
  try {
    const res = await fetch(`/api/chat/prefs?service=${SERVICE}`, { signal })
    if (!res.ok) return null
    const data = (await res.json()) as {
      prefs?: Record<string, ConvPrefsDto>
      folderOrder?: string[]
    }
    return {
      prefs: data.prefs ?? {},
      folderOrder: Array.isArray(data.folderOrder) ? data.folderOrder : [],
    }
  } catch {
    return null
  }
}

/** Global people suggestions for the search box's `from:` operator (PSN-115). Returns the
 *  display-name cache (everyone the BFF has seen), fold-matched server-side. Best-effort: a
 *  network/error returns an empty list so the suggestion popover just closes — never blocks
 *  typing. */
export async function fetchPeople(q: string, signal?: AbortSignal): Promise<PersonSuggestion[]> {
  try {
    const res = await fetch(`/api/chat/people?service=${SERVICE}&q=${encodeURIComponent(q)}`, {
      signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as { people?: PersonSuggestion[] }
    return Array.isArray(data.people) ? data.people : []
  } catch {
    return []
  }
}

/** Fetch one user's profile card. Throws ChatApiError with the server's typed code. */
export async function fetchProfile(userId: string, signal?: AbortSignal): Promise<TeamsProfile> {
  const res = await fetch(
    `/api/chat/profile?service=${SERVICE}&userId=${encodeURIComponent(userId)}`,
    { signal },
  )
  const data = (await res.json().catch(() => ({}))) as { profile?: TeamsProfile; error?: string }
  if (!res.ok || data.error || !data.profile)
    throw new ChatApiError(data.error || `http_${res.status}`, res.status)
  return data.profile
}

/** The URL for a user's avatar image (proxied through the BFF provider). `size` requests a larger
 *  Graph photo (e.g. "240x240") for the profile modal + lightbox (PSN-99); omit → provider default. */
export function avatarUrl(userId: string, size?: string): string {
  const s = size ? `&size=${encodeURIComponent(size)}` : ""
  return `/api/chat/avatar?service=${SERVICE}&userId=${encodeURIComponent(userId)}${s}`
}

/** The URL for a provider-hosted media object (proxied + SSRF-gated by the BFF provider). */
export function mediaUrl(url: string): string {
  return `/api/chat/media?service=${SERVICE}&url=${encodeURIComponent(url)}`
}

/** One superseded body of a message, plus when it was replaced (PSN-105 C). */
export interface MessageVersion {
  body: string
  editTs: number | null
  capturedAt: number | null
}

export interface MessageHistory {
  /** Superseded bodies, NEWEST first. Empty = no change was observed while this server was up. */
  versions: MessageVersion[]
  current: { body: string; deleted: boolean; ts: number | null } | null
  /** The per-message cap was hit — older versions were dropped, and the UI must say so. */
  truncated: boolean
  cap: number
}

/** A message's LOCAL edit/delete history. Teams keeps no previous version, so this only ever holds
 *  what our BFF observed after the feature shipped. */
export async function fetchMessageHistory(
  convId: string,
  msgId: string,
  signal?: AbortSignal,
): Promise<MessageHistory> {
  const q = new URLSearchParams({ service: SERVICE, convId, msgId })
  const res = await fetch(`/api/chat/message-history?${q}`, { signal })
  const data = (await res.json().catch(() => ({}))) as MessageHistory & { error?: string }
  if (!res.ok || data.error) throw new ChatApiError(data.error || `http_${res.status}`, res.status)
  return { ...data, versions: data.versions ?? [] }
}

export interface MediaCaption {
  status: "pending" | "done" | "failed" | "unsupported"
  caption: string | null
}

/** An inline image's transcription (PSN-104). Made once at ingest for new images; an older one is
 *  transcribed on this call, so the request can take a few seconds — the caller shows a pending
 *  state rather than blocking the lightbox. */
export async function fetchMediaCaption(
  convId: string,
  msgId: string,
  src: string,
  signal?: AbortSignal,
): Promise<MediaCaption> {
  const q = new URLSearchParams({ service: SERVICE, convId, msgId, url: src })
  const res = await fetch(`/api/chat/media/caption?${q}`, { signal })
  const data = (await res.json().catch(() => ({}))) as MediaCaption & { error?: string }
  if (!res.ok || data.error) throw new ChatApiError(data.error || `http_${res.status}`, res.status)
  return data
}

// ---- writes (ported for WS-F; no consumers this workstream) ----------------

export interface SendReplyResult {
  ok: true
  ts: string
  clientMessageId: string
}

export async function sendReply(
  convId: string,
  text: string,
  html?: string | null,
  quotes?: ReplyRef[],
  mentions?: MentionRef[],
): Promise<SendReplyResult> {
  return post<SendReplyResult>("reply", {
    convId,
    text,
    ...(html ? { html } : {}),
    ...(quotes?.length ? { quotes } : {}),
    // The BFF contract names the mentioned user `id` (Teams mri → contract id; PSN-93) while the FE
    // type + the composer carry `mri` — the mirror of the fetchRoster normalization above. Without
    // this the provider read `m.id` off an `mri`-shaped entry, so EVERY outgoing properties.mentions
    // entry lost its mri and Teams stored mention-shaped markup that mentioned nobody (PSN-120).
    ...(mentions?.length
      ? {
          mentions: mentions.map((m) => ({
            itemid: m.itemid,
            id: m.mri,
            displayName: m.displayName,
          })),
        }
      : {}),
  })
}

export async function react(
  convId: string,
  msgId: string,
  key: string,
  remove: boolean,
): Promise<void> {
  try {
    await post("react", { convId, msgId, key, remove })
  } catch {
    // best-effort: the optimistic chip stands until the next sweep reconciles
  }
}

export async function editMessage(convId: string, msgId: string, text: string): Promise<void> {
  await post("edit", { convId, msgId, text })
}

export async function deleteMessage(convId: string, msgId: string): Promise<void> {
  await post("delete", { convId, msgId })
}

export async function fetchRoster(convId: string): Promise<RosterMember[]> {
  try {
    const data = await post<{
      members?: { id?: string; mri?: string; name: string; self?: boolean }[]
    }>("roster", { convId })
    if (!Array.isArray(data.members)) return []
    // The BFF contract names the member id `id` (Teams mri → contract id; PSN-93), but the FE type +
    // the composer read `mri`. Normalize here so a mention pill carries a REAL mri — an empty mri
    // makes `outgoingFromEditor` emit per-word spans that the render-side merge (t140, groups by
    // shared mri) can't recombine, so one @mention renders as a pill per word.
    return data.members.map((m) => ({ mri: m.mri ?? m.id ?? "", name: m.name, self: m.self }))
  } catch {
    return []
  }
}

/** Read a File as base64 (the `data:…;base64,` prefix stripped) for JSON transport. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const result = String(fr.result)
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    fr.onerror = () => reject(fr.error ?? new Error("read failed"))
    fr.readAsDataURL(file)
  })
}

/** An image File's natural dimensions. Best-effort — a decode failure resolves 0×0. */
function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    const done = (width: number, height: number) => {
      URL.revokeObjectURL(url)
      resolve({ width, height })
    }
    img.onload = () => done(img.naturalWidth, img.naturalHeight)
    img.onerror = () => done(0, 0)
    img.src = url
  })
}

export async function uploadImage(
  convId: string,
  file: File,
  text?: string,
): Promise<{ msgId: string }> {
  const [base64, { width, height }] = await Promise.all([fileToBase64(file), imageDimensions(file)])
  const data = await post<{ msgId?: string }>("upload-image", {
    convId,
    filename: file.name || "image.png",
    base64,
    contentType: file.type || "image/png",
    width,
    height,
    text: text?.trim() || undefined,
  })
  if (!data.msgId) throw new ChatApiError("no_msg_id", 500)
  return { msgId: data.msgId }
}

export async function uploadImages(
  convId: string,
  files: File[],
  text?: string,
): Promise<{ msgId: string }> {
  const images = await Promise.all(
    files.map(async (file) => {
      const [base64, { width, height }] = await Promise.all([
        fileToBase64(file),
        imageDimensions(file),
      ])
      return {
        filename: file.name || "image.png",
        base64,
        contentType: file.type || "image/png",
        width,
        height,
      }
    }),
  )
  const data = await post<{ msgId?: string }>("upload-images", {
    convId,
    images,
    text: text?.trim() || undefined,
  })
  if (!data.msgId) throw new ChatApiError("no_msg_id", 500)
  return { msgId: data.msgId }
}

export async function uploadFile(
  convId: string,
  file: File,
  text?: string,
): Promise<{ msgId: string }> {
  const base64 = await fileToBase64(file)
  const data = await post<{ msgId?: string }>("upload-file", {
    convId,
    filename: file.name || "file",
    base64,
    contentType: file.type || "application/octet-stream",
    text: text?.trim() || undefined,
  })
  if (!data.msgId) throw new ChatApiError("no_msg_id", 500)
  return { msgId: data.msgId }
}

export async function setPrefs(
  convId: string,
  patch: {
    labels?: string[]
    folder?: string | null
    muted?: boolean
    mutedUntil?: number | null
    notifyOnMention?: boolean
    customTitle?: string | null
  },
): Promise<ConvPrefsDto | null> {
  try {
    const data = await post<{ prefs?: ConvPrefsDto }>("prefs", { convId, ...patch })
    return data.prefs ?? null
  } catch {
    return null
  }
}

export async function setFolderOrder(order: string[]): Promise<string[] | null> {
  try {
    const data = await post<{ folderOrder?: string[] }>("prefs", { folderOrder: order })
    return data.folderOrder ?? null
  } catch {
    return null
  }
}

/** Mark a conversation read (PSN-102). Writes Teams consumptionhorizon + clears the bookmark.
 *  Throws ChatApiError on failure — the caller owns the revert. */
export async function markRead(convId: string, msgId: string, ts: string): Promise<void> {
  await post("mark-read", { convId, msgId, ts })
}

/** Mark a conversation unread (PSN-102). Writes Teams consumptionHorizonBookmark.
 *  Throws ChatApiError on failure — the caller owns the revert. */
export async function markUnread(convId: string, ts: number): Promise<void> {
  await post("mark-unread", { convId, ts })
}

// ---- build identity + sync diagnostics ------------------------------------

import type { BackfillRun, SyncLogData } from "./sync-log"

export interface VersionInfo {
  version: string
  sha: string
  builtAt?: string
}

/** The web server's (/api/version) build identity. Null on failure. */
export async function getServerVersion(): Promise<VersionInfo | null> {
  try {
    const res = await fetch("/api/version")
    if (!res.ok) return null
    return (await res.json()) as VersionInfo
  } catch {
    return null
  }
}

/** The chat BFF's (/api/chat/version) build identity. Null on failure. */
export async function getBffVersion(): Promise<VersionInfo | null> {
  try {
    const res = await fetch("/api/chat/version")
    if (!res.ok) return null
    return (await res.json()) as VersionInfo
  } catch {
    return null
  }
}

/** The BFF's sync log (last 20 events + error info). Throws on failure. */
export async function getSyncLog(): Promise<SyncLogData> {
  const res = await fetch("/api/chat/sync-log")
  if (!res.ok) throw new ChatApiError(`http_${res.status}`, res.status)
  return (await res.json()) as SyncLogData
}

// ---- backfill (PSN-93 WS-H) ------------------------------------------------

import type { BackfillStatus } from "../../../apps/chat-server/src/contract"

export type { BackfillRun }

/** Start a backfill run for the last `days` days. No-op while one is already running (the server
 *  ignores a second start). Throws ChatApiError on a hard failure (e.g. no keeper tab). */
export async function startBackfill(days: number): Promise<void> {
  await post("backfill", { action: "start", days })
}

/** Poll the current backfill status. Returns null on network failure (caller keeps prior state). */
export async function getBackfillStatus(): Promise<
  (BackfillStatus & { history?: BackfillRun[] }) | null
> {
  try {
    const res = await fetch(`/api/chat/backfill?service=${SERVICE}`)
    if (!res.ok) return null
    return (await res.json()) as BackfillStatus & { history?: BackfillRun[] }
  } catch {
    return null
  }
}

// ---- search (PSN-115 WS-E) -------------------------------------------------

// Mirror the server contract (`apps/chat-server/src/contract.ts`) for the FE. Field-identical —
// re-exported so component imports come from one place. Same raw-import pattern as BackfillStatus.
export type {
  ParsedFilters,
  ParsedQuery,
  SearchHit,
  SearchPage,
  SearchScope,
} from "../../../apps/chat-server/src/contract"

/** A people-suggestion row for the search box's `from:` operator (PSN-115). Mirrors the server's
 *  `PersonCandidate` (`apps/chat-server/src/search.ts`) without importing it — keeps the FE
 *  boundary clean. */
export interface PersonSuggestion {
  id: string
  displayName: string
}

import type { SearchPage, SearchScope } from "../../../apps/chat-server/src/contract"

export type SearchSort = "relevance" | "recent"

/** Run a global message search. `query` is raw KQL — the server parses. Empty query returns an
 *  empty page without erroring (the FE shows the empty state). `scope` defaults to `{kind:"all"}`;
 *  omit it on the wire so the server keeps its own default. */
export async function searchMessages(
  query: string,
  opts?: {
    sort?: SearchSort
    scope?: SearchScope
    cursor?: string | null
    signal?: AbortSignal
  },
): Promise<SearchPage> {
  const data = await post<SearchPage>(
    "search",
    {
      query,
      ...(opts?.sort ? { sort: opts.sort } : {}),
      ...(opts?.scope && opts.scope.kind !== "all" ? { scope: opts.scope } : {}),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    },
    opts?.signal,
  )
  // Defensively fill — a misbehaving proxy mustn't crash the render.
  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    parsed: data.parsed ?? { text: query, filters: {} },
    cursor: data.cursor ?? null,
    total: typeof data.total === "number" ? data.total : (data.rows?.length ?? 0),
    ...(data.degraded ? { degraded: data.degraded } : {}),
  }
}
