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
  // Media → alt text (or nothing). <img alt="x"> keeps "x"; alt-less media vanish.
  s = s.replace(/<(img|video|audio)\b[^>]*>/gi, (tag) => {
    const alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag) || /\balt\s*=\s*'([^']*)'/i.exec(tag)
    return alt ? ` ${alt[1]} ` : " "
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

/** body → the folded plain-text shadow the index stores. Empty when nothing indexable remains. */
export function indexText(body: string): string {
  return fold(stripHtml(body))
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
export function syncMessageFts(db: Db, rowid: number, body: string, deleted: boolean): void {
  db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(rowid)
  if (deleted) return
  const text = indexText(body)
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
   *  matching only, never shown. */
  snippet: string
}

const SNIPPET_CAP = 240

export interface SearchOpts {
  query: string
  service?: string
  /** Exact sender id (resolve names via `resolvePerson` first). */
  sender?: string
  convId?: string
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
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? opts.limit : 20
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
        AND (@after IS NULL OR m.ts >= @after)
        AND (@before IS NULL OR m.ts <= @before)
        AND (@mentionsMe IS NULL OR m.mentions_me = @mentionsMe)
      ORDER BY f.rank, m.ts DESC
      LIMIT @limit
    `)
    .all({
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
  return rows.map((r) => ({
    service: r.service,
    convId: r.conv_id,
    msgId: r.id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    ts: r.ts,
    snippet: stripHtml(r.body).slice(0, SNIPPET_CAP),
  }))
}

export interface WindowMessage {
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
  return rows.map((r) => ({
    msgId: r.id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    ts: r.ts,
    text: r.deleted ? "" : stripHtml(r.body),
    deleted: !!r.deleted,
  }))
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

/** Fold-matched substring lookup over conversation title/topic, newest-first. Empty query lists
 *  the newest conversations. */
export function listConversationsByQuery(
  db: Db,
  service: string,
  opts: { query?: string; limit?: number } = {},
): ConversationHit[] {
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
