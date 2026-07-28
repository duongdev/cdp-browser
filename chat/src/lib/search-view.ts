// Pure helpers for the full-screen message search surface (PSN-115 WS-E).
// Snippet highlighting (wrap matched free-text in <mark>), recent-search persistence, and the
// hydrate-flip reducer that lets a `messages-upsert` WS delta flip `hydrated:false` rows in place.
//
// No React, no I/O except localStorage (injected for tests). Pure so the reducer + chip render
// are unit-testable in isolation.

import type { SearchHit } from "./chat-client"

/** Split `snippet` into segments around case-insensitive matches of `term`. Returns `null` when
 *  `term` is blank or not found — the caller renders the snippet verbatim in that case. The
 *  returned array alternates plain / matched / plain / …, with always at least 3 entries when
 *  a match exists. */
export function highlightSegments(snippet: string, term: string): string[] | null {
  const t = term.trim()
  if (!t || !snippet) return null
  const lower = snippet.toLowerCase()
  const needle = t.toLowerCase()
  if (!lower.includes(needle)) return null
  const out: string[] = []
  let i = 0
  while (i < snippet.length) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      out.push(snippet.slice(i))
      break
    }
    if (at > i) out.push(snippet.slice(i, at))
    out.push(snippet.slice(at, at + needle.length))
    i = at + needle.length
  }
  return out.length > 1 ? out : null
}

/** Cap on persisted recent searches. Slack-style — a short list, most-recent first. */
export const MAX_RECENT_SEARCHES = 5

/** Storage key (chat-scoped). Mirrors the `chat:*` convention used elsewhere in the FE. */
export const RECENT_SEARCHES_KEY = "chat:recent-searches"

/** Add `query` to the top of the list, dedupe, cap at MAX_RECENT_SEARCHES. Blank queries are
 *  ignored (the caller shouldn't persist them, but the guard is here anyway). Returns the new
 *  list. Pure — the caller owns the persistence side effect. */
export function addRecentSearch(list: string[], query: string): string[] {
  const q = query.trim()
  if (!q) return list
  const rest = list.filter((x) => x !== q)
  return [q, ...rest].slice(0, MAX_RECENT_SEARCHES)
}

/** Load the recent-search list. Tolerant of corruption — a malformed payload resets to empty. */
export function loadRecentSearchs(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT_SEARCHES)
  } catch {
    return []
  }
}

/** Serialise the list for storage. */
export function serializeRecentSearchs(list: string[]): string {
  return JSON.stringify(list.slice(0, MAX_RECENT_SEARCHES))
}

/**
 * Apply a `messages-upsert` payload to the search rows: any row whose `(convId, msgId)` appears
 *  in the incoming messages and is still `hydrated:false` flips to `hydrated:true`. Returns the
 *  SAME array reference when nothing changed (no re-render), a new array otherwise.
 *
 * This is the hydrate-live-flip: a substrate hit's matched window is pulled into `chat.db` after
 * the page lands; when the hydrate completes, the BFF's existing `messages-upsert` WS delta
 * arrives carrying the message — flip the row so the indicator clears without a refetch.
 */
export function applyHydrated(
  rows: SearchHit[],
  incoming: { id: string }[],
  convId: string,
): SearchHit[] {
  if (rows.length === 0 || incoming.length === 0) return rows
  const ids = new Set(incoming.map((m) => m.id))
  if (ids.size === 0) return rows
  let changed = false
  const next = rows.map((row) => {
    if (row.hydrated) return row
    if (row.convId !== convId) return row
    if (!ids.has(row.msgId)) return row
    changed = true
    return { ...row, hydrated: true }
  })
  return changed ? next : rows
}
