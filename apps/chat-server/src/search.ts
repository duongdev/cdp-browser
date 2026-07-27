// Search foundation for the AI assistant (t171, ADR-0021 decision 2). An FTS5 index over a
// pre-folded plain-text shadow of `messages.body`, plus the pure query functions the assistant's
// tools call. Vietnamese-aware: FTS5's `remove_diacritics=2` folds tone marks but NOT đ/Đ (a
// stroked letter with no combining-mark decomposition), so `fold` is applied at index AND query
// time — `duong` finds `đường`.
//
// The FTS table stores its own copy of the folded text keyed by `messages.rowid` (a plain fts5
// table, not external-content: plain tables support ordinary DELETE with zero trigger-drift risk;
// the folded shadow is small). All maintenance goes through `syncMessageFts`, called from the one
// write path (`upsertMessages` in store.ts) — never SQL triggers (ADR-0021 consequence).

import type BetterSqlite3 from "better-sqlite3"
import { type CaptionStatus, listMessageImages } from "./media-store.ts"

type Db = BetterSqlite3.Database

// ---- fold + strip ---------------------------------------------------------

/** Diacritic + case fold, mirroring `src/lib/fold-text.ts` / `core/history-store.js`:
 *  NFD strips combining marks; đ/Đ don't decompose so they're replaced explicitly. */
export function fold(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/** Rendered-HTML body → plain text for indexing: media elements reduced to their alt text,
 *  tags dropped, entities decoded, whitespace collapsed. */
export function stripHtml(html: string): string {
  let s = html || ""
  // Anchors keep their HREF, not just the visible text (PSN-104): Teams renders a long URL with its
  // own "…" truncation, so dropping the href handed the assistant an unusable half-URL — it then
  // "quoted" a link nobody could open. A descriptive label is kept alongside the URL.
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_whole, dq: string | undefined, sq: string | undefined, inner: string) => {
      const href = (dq ?? sq ?? "").trim()
      const text = inner
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      if (!href) return ` ${text} `
      // Text that is itself a (possibly truncated) URL adds nothing next to the real href.
      const textIsUrl = /^(https?:\/\/|www\.)/i.test(text) || text === ""
      return textIsUrl ? ` ${href} ` : ` ${text} ${href} `
    },
  )
  // Media → alt text, plus a numbered marker for a real inline image (PSN-104). Without it an
  // image is invisible to the assistant, which then answers "there's nothing there" about a message
  // that IS a screenshot. The number is what `view_image`'s `index` refers to. Emoji and stickers
  // load from a public CDN (unproxied src), so they never earn a marker.
  let imageN = 0
  s = s.replace(/<(img|video|audio)\b[^>]*>/gi, (tag: string, kind: string) => {
    const alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag) || /\balt\s*=\s*'([^']*)'/i.exec(tag)
    const label = alt ? ` ${alt[1]} ` : " "
    if (kind.toLowerCase() !== "img" || !/\bsrc\s*=\s*["'][^"']*\/api\/chat\/media\?/i.test(tag)) {
      return label
    }
    imageN++
    return `${label}[image#${imageN}] `
  })
  // Block-ish closers become spaces so words don't glue across elements.
  s = s.replace(/<[^>]*>/g, " ")
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
  s = s.replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number.parseInt(dec, 10)))
  s = s.replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
  return s.replace(/\s+/g, " ").trim()
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return ""
  try {
    return String.fromCodePoint(n)
  } catch {
    return ""
  }
}

/** body → the folded plain-text shadow the index stores. Empty when nothing indexable remains.
 *  Quoted reply text stays IN the index on purpose — searching a phrase should find the message
 *  that quoted it too. */
export function indexText(body: string, captions: string[] = []): string {
  const extra = captions.filter(Boolean).join(" ")
  return fold(extra ? `${stripHtml(body)} ${extra}` : stripHtml(body))
}

// ---- reply chains ----------------------------------------------------------
// A Teams reply carries the parent inline: `<blockquote itemtype="…/Reply" itemid="{parentMsgId}">`
// wrapping the quoted text, followed by the author's own words. Flattening that with the rest of
// the body (what stripHtml alone does) hands the model ONE utterance and no parent id — so it can
// attribute the quoted sentence to the replier and can't follow the thread. Split them instead.

const REPLY_BLOCKQUOTE_RE =
  /<blockquote\b[^>]*\bitemtype\s*=\s*(["'])[^"']*Reply[^"']*\1[^>]*>([\s\S]*?)<\/blockquote>/gi

export interface ReplyQuote {
  /** The quoted message's id — feed it to `getContextWindow({aroundMsgId})` to read the original. */
  msgId?: string
  sender?: string
  excerpt: string
}

const QUOTE_EXCERPT_CAP = 160

/** Split a body into the author's OWN words and the messages it quotes. */
export function splitReplyQuotes(html: string): { own: string; quotes: ReplyQuote[] } {
  const raw = html || ""
  if (!raw.toLowerCase().includes("<blockquote")) return { own: stripHtml(raw), quotes: [] }
  const quotes: ReplyQuote[] = []
  const own = raw.replace(REPLY_BLOCKQUOTE_RE, (whole, _q, inner: string) => {
    const id = /\bitemid\s*=\s*(["'])([^"']+)\1/i.exec(whole)?.[2]
    // Teams renders the quoted author in the first <strong> inside the blockquote.
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(inner)?.[1]
    const sender = strong ? stripHtml(strong) : undefined
    const body = sender ? inner.replace(/<strong\b[^>]*>[\s\S]*?<\/strong>/i, " ") : inner
    quotes.push({
      msgId: id,
      sender: sender || undefined,
      excerpt: stripHtml(body).slice(0, QUOTE_EXCERPT_CAP),
    })
    return " "
  })
  return { own: stripHtml(own), quotes }
}

// ---- schema + sync --------------------------------------------------------

/** Idempotent — called from store.ts `migrate()`. `remove_diacritics=2` is belt-and-suspenders on
 *  top of the JS pre-fold (it folds marks the fold regex might miss; đ is handled by the fold). */
export function migrateSearch(db: Db): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')`)
}

/** Keep one message's index row in lockstep with its `messages` row. Deleted/tombstoned or
 *  empty-after-strip messages are absent from the index. Called inside the `upsertMessages`
 *  transaction — the single write funnel. */
export function syncMessageFts(
  db: Db,
  rowid: number,
  body: string,
  deleted: boolean,
  captions: string[] = [],
): void {
  db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(rowid)
  if (deleted) return
  const text = indexText(body, captions)
  if (!text) return
  db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(rowid, text)
}

/** Index every stored message not yet indexed (boot backfill). Idempotent — re-running indexes
 *  nothing new. One transaction; returns how many rows it indexed. */
export function backfillSearchIndex(db: Db): number {
  const rows = db
    .prepare(`SELECT rowid, body, deleted FROM messages
      WHERE deleted = 0 AND rowid NOT IN (SELECT rowid FROM messages_fts)`)
    .all() as { rowid: number; body: string; deleted: number }[]
  let indexed = 0
  const run = db.transaction(() => {
    for (const r of rows) {
      const text = indexText(r.body)
      if (!text) continue
      db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(r.rowid, text)
      indexed++
    }
  })
  run()
  return indexed
}

// ---- queries --------------------------------------------------------------

/** Fold the user query and quote each token so FTS MATCH syntax chars can't break the query.
 *  Tokens AND together (FTS default). Empty → null (caller returns []). */
export function toMatchQuery(query: string): string | null {
  const tokens = fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  return tokens.length ? tokens.join(" ") : null
}

export interface SearchHit {
  service: string
  convId: string
  msgId: string
  senderId: string | null
  senderName: string | null
  ts: number | null
  /** Plain-text excerpt of the ORIGINAL body (diacritics intact) — the folded index text is for
   *  matching only, never shown. Excludes quoted reply text, which rides `quotes` instead. */
  snippet: string
  /** Messages this one replies to (Teams inlines them as a quote block). Empty for a plain message. */
  quotes?: ReplyQuote[]
  /** Inline images and their transcriptions (PSN-104), matching the `[image#N]` markers in the
   *  text. Absent when the message has none. */
  images?: MessageImageInfo[]
}

/** What a retrieval tool tells the model about one inline image. */
export interface MessageImageInfo {
  index: number
  status: CaptionStatus
  /** The transcription, when one exists. A vision model can still `view_image` the raw pixels. */
  caption: string | null
}

/** Images + transcriptions for a message whose text carries `[image#N]` markers. Cheap enough to
 *  call per returned row (tool results are capped at tens of rows). */
export function imagesForMessage(
  db: Db,
  service: string,
  convId: string,
  msgId: string,
): MessageImageInfo[] {
  return listMessageImages(db, service, convId, msgId).map((r) => ({
    index: r.index,
    status: r.status,
    caption: r.caption,
  }))
}

const hasImageMarker = (text: string) => text.includes("[image#")

const SNIPPET_CAP = 240

export interface SearchOpts {
  query: string
  service?: string
  /** Exact sender id (resolve names via `resolvePerson` first). */
  sender?: string
  convId?: string
  /** Restrict to a set of conversations — how a folder/label scope is applied (resolveScope).
   *  Empty array means "no conversation qualifies", NOT "unfiltered". */
  convIds?: string[]
  /** ts range, exclusive of nothing — after <= ts <= before. */
  after?: number
  before?: number
  /** Only messages that @-mention the user. Uses the provider's authoritative `mentions_me` flag —
   *  searching the user's NAME is not equivalent: it matches anyone merely talking ABOUT them and
   *  misses mentions rendered under a different display name. */
  mentionsMe?: boolean
  limit?: number
}

/** FTS MATCH on the folded query + SQL filters, relevance (bm25) then recency. */
export function searchMessages(db: Db, opts: SearchOpts): SearchHit[] {
  const match = toMatchQuery(opts.query)
  if (!match) return []
  if (opts.convIds && opts.convIds.length === 0) return []
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? opts.limit : 20
  // A scope is a variable-length IN list — generated named placeholders keep every value bound
  // (the rest of this query binds by name, and the two styles can't be mixed).
  const scopeIds = opts.convIds ?? []
  const scope = scopeIds.length
    ? `AND m.conv_id IN (${scopeIds.map((_, i) => `@scope${i}`).join(",")})`
    : ""
  const scopeParams = Object.fromEntries(scopeIds.map((id, i) => [`scope${i}`, id]))
  const rows = db
    .prepare(`
      SELECT m.service, m.conv_id, m.id, m.sender_id, m.sender_name, m.ts, m.body
      FROM messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH @match
        AND m.deleted = 0
        AND (@service IS NULL OR m.service = @service)
        AND (@sender IS NULL OR m.sender_id = @sender)
        AND (@convId IS NULL OR m.conv_id = @convId)
        ${scope}
        AND (@after IS NULL OR m.ts >= @after)
        AND (@before IS NULL OR m.ts <= @before)
        AND (@mentionsMe IS NULL OR m.mentions_me = @mentionsMe)
      ORDER BY f.rank, m.ts DESC
      LIMIT @limit
    `)
    .all({
      ...scopeParams,
      match,
      service: opts.service ?? null,
      sender: opts.sender ?? null,
      convId: opts.convId ?? null,
      after: opts.after ?? null,
      before: opts.before ?? null,
      mentionsMe: opts.mentionsMe ? 1 : null,
      limit,
    }) as {
    service: string
    conv_id: string
    id: string
    sender_id: string | null
    sender_name: string | null
    ts: number | null
    body: string
  }[]
  return rows.map((r) => {
    const { own, quotes } = splitReplyQuotes(r.body)
    return {
      service: r.service,
      convId: r.conv_id,
      msgId: r.id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      ts: r.ts,
      snippet: own.slice(0, SNIPPET_CAP),
      ...(quotes.length ? { quotes } : {}),
      ...(hasImageMarker(own) ? { images: imagesForMessage(db, r.service, r.conv_id, r.id) } : {}),
    }
  })
}

export interface WindowMessage {
  /** Messages this one replies to — the parent's id lets the model walk the chain. */
  quotes?: ReplyQuote[]
  /** Inline images + transcriptions, matching the `[image#N]` markers in `text` (PSN-104). */
  images?: MessageImageInfo[]
  msgId: string
  senderId: string | null
  senderName: string | null
  ts: number | null
  text: string
  deleted: boolean
}

/** A message window from the DB — around a target message, or before a ts, or the newest. No
 *  provider calls. Ordered oldest→newest. */
export function getContextWindow(
  db: Db,
  service: string,
  opts: { convId: string; aroundMsgId?: string; beforeTs?: number; limit?: number },
): WindowMessage[] {
  const limit =
    Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.floor(opts.limit as number)
      : 20
  let rows: WinRow[]
  if (opts.aroundMsgId) {
    const target = db
      .prepare("SELECT ts FROM messages WHERE service = ? AND conv_id = ? AND id = ?")
      .get(service, opts.convId, opts.aroundMsgId) as { ts: number | null } | undefined
    if (!target) return []
    const half = Math.max(1, Math.floor(limit / 2))
    const before = db
      .prepare(`
        SELECT id, sender_id, sender_name, ts, body, deleted FROM messages
        WHERE service = @service AND conv_id = @convId AND ts <= @ts
        ORDER BY ts DESC, id DESC LIMIT @n
      `)
      .all({ service, convId: opts.convId, ts: target.ts, n: half + 1 }) as WinRow[]
    const after = db
      .prepare(`
        SELECT id, sender_id, sender_name, ts, body, deleted FROM messages
        WHERE service = @service AND conv_id = @convId AND ts > @ts
        ORDER BY ts ASC, id ASC LIMIT @n
      `)
      .all({ service, convId: opts.convId, ts: target.ts, n: half }) as WinRow[]
    rows = [...before.reverse(), ...after]
  } else {
    const before = Number.isFinite(opts.beforeTs) ? opts.beforeTs : null
    rows = (
      db
        .prepare(`
        SELECT id, sender_id, sender_name, ts, body, deleted FROM messages
        WHERE service = @service AND conv_id = @convId
          AND (@before IS NULL OR ts < @before)
        ORDER BY ts DESC, id DESC LIMIT @limit
      `)
        .all({ service, convId: opts.convId, before, limit }) as WinRow[]
    ).reverse()
  }
  return rows.map((r) => {
    const { own, quotes } = r.deleted ? { own: "", quotes: [] } : splitReplyQuotes(r.body)
    return {
      msgId: r.id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      ts: r.ts,
      text: own,
      deleted: !!r.deleted,
      ...(hasImageMarker(own) ? { images: imagesForMessage(db, service, opts.convId, r.id) } : {}),
      ...(quotes.length ? { quotes } : {}),
    }
  })
}

interface WinRow {
  id: string
  sender_id: string | null
  sender_name: string | null
  ts: number | null
  body: string
  deleted: number
}

export interface ConversationHit {
  id: string
  kind: string | null
  title: string | null
  lastMessageTs: number | null
}

// ---- scopes: the user's own folders + labels -------------------------------
// A conversation's folder (one) and labels (many) are LOCAL organisation the user did by hand
// (`conversation_prefs`, t156) — never provider state. They are the names the user actually thinks
// in ("look in my FWD folder"), so the assistant resolves them the same way the sidebar does.

export interface ScopeName {
  name: string
  /** How many conversations carry it — lets the model pick between near-identical names. */
  count: number
}

export interface Scopes {
  folders: ScopeName[]
  labels: ScopeName[]
}

/** Every folder + label the user has actually assigned, with conversation counts. */
export function listScopes(db: Db, service: string): Scopes {
  const rows = db
    .prepare("SELECT folder, labels FROM conversation_prefs WHERE service = ?")
    .all(service) as { folder: string | null; labels: string | null }[]
  const folders = new Map<string, number>()
  const labels = new Map<string, number>()
  for (const r of rows) {
    const folder = (r.folder || "").trim()
    if (folder) folders.set(folder, (folders.get(folder) ?? 0) + 1)
    for (const l of parseLabelList(r.labels)) labels.set(l, (labels.get(l) ?? 0) + 1)
  }
  const toList = (m: Map<string, number>): ScopeName[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { folders: toList(folders), labels: toList(labels) }
}

function parseLabelList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []
  } catch {
    return []
  }
}

export interface ResolvedScope {
  kind: "folder" | "label"
  /** The stored name, not what the user typed. */
  name: string
  convIds: string[]
}

/** Resolve a user-typed folder/label name to its conversation ids. Fold-matched (so "fwd" finds
 *  "FWD" and diacritics don't matter), exact match preferred over substring; a folder wins a tie
 *  with a label. Null when nothing matches — the caller shows the real list instead of guessing. */
export function resolveScope(db: Db, service: string, rawName: string): ResolvedScope | null {
  const want = fold(rawName || "").trim()
  if (!want) return null
  const rows = db
    .prepare("SELECT conv_id, folder, labels FROM conversation_prefs WHERE service = ?")
    .all(service) as { conv_id: string; folder: string | null; labels: string | null }[]
  const buckets = new Map<string, { kind: "folder" | "label"; name: string; convIds: string[] }>()
  const add = (kind: "folder" | "label", name: string, convId: string) => {
    const key = `${kind}\n${name}`
    const b = buckets.get(key) ?? { kind, name, convIds: [] }
    b.convIds.push(convId)
    buckets.set(key, b)
  }
  for (const r of rows) {
    const folder = (r.folder || "").trim()
    if (folder) add("folder", folder, r.conv_id)
    for (const l of parseLabelList(r.labels)) add("label", l, r.conv_id)
  }
  const candidates = [...buckets.values()]
  const exact = candidates.filter((c) => fold(c.name).trim() === want)
  const partial = candidates.filter((c) => fold(c.name).includes(want))
  const pool = exact.length ? exact : partial
  if (!pool.length) return null
  // Folder before label, then the bigger bucket — a deterministic pick beats an arbitrary one.
  pool.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || b.convIds.length - a.convIds.length,
  )
  return pool[0]
}

/** Fold-matched substring lookup over conversation title/topic, newest-first. Empty query lists
 *  the newest conversations. */
export function listConversationsByQuery(
  db: Db,
  service: string,
  opts: { query?: string; limit?: number; convIds?: string[] } = {},
): ConversationHit[] {
  if (opts.convIds && opts.convIds.length === 0) return []
  const inScope = opts.convIds?.length ? new Set(opts.convIds) : null
  const limit =
    Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.floor(opts.limit as number)
      : 20
  const rows = db
    .prepare(`
      SELECT id, kind, title, topic, last_message_ts FROM conversations
      WHERE service = ? ORDER BY last_message_ts DESC NULLS LAST, id
    `)
    .all(service) as {
    id: string
    kind: string | null
    title: string | null
    topic: string | null
    last_message_ts: number | null
  }[]
  const q = fold(opts.query || "").trim()
  const out: ConversationHit[] = []
  for (const r of rows) {
    if (inScope && !inScope.has(r.id)) continue
    const label = r.title || r.topic || ""
    if (q && !fold(label).includes(q)) continue
    out.push({ id: r.id, kind: r.kind, title: label || null, lastMessageTs: r.last_message_ts })
    if (out.length >= limit) break
  }
  return out
}

export interface PersonCandidate {
  id: string
  displayName: string
}

/** Fold-matched lookup over the `users` display-name cache. */
export function resolvePerson(
  db: Db,
  service: string,
  opts: { name: string; limit?: number },
): PersonCandidate[] {
  const q = fold(opts.name || "").trim()
  if (!q) return []
  const limit =
    Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.floor(opts.limit as number) : 8
  const rows = db.prepare("SELECT id, display_name FROM users WHERE service = ?").all(service) as {
    id: string
    display_name: string | null
  }[]
  const out: PersonCandidate[] = []
  for (const r of rows) {
    if (!r.display_name) continue
    if (!fold(r.display_name).includes(q)) continue
    out.push({ id: r.id, displayName: r.display_name })
    if (out.length >= limit) break
  }
  return out
}
