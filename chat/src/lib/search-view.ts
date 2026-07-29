// Pure helpers for the full-screen message search surface (PSN-115 WS-E + WS-F).
// Snippet highlighting (wrap matched free-text in <mark>), recent-search persistence, the
// hydrate-flip reducer that lets a `messages-upsert` WS delta flip `hydrated:false` rows in place,
// and the parsed-query → filter-chip reducer + sort/scope constants for the filter bar (WS-F).
//
// No React, no I/O except localStorage (injected for tests). Pure so the reducer + chip render
// are unit-testable in isolation.

import type { ParsedQuery, SearchHit } from "./chat-client"

/** Split `snippet` into segments around case-insensitive matches of `term`. Returns `null` when
 *  `term` is blank or not found — the caller renders the snippet verbatim in that case. The
 *  returned array ALWAYS alternates plain (even index) / matched (odd index) — a leading match
 *  gets a leading empty-string plain segment so parity holds even when the term opens the
 *  snippet. Without this, a match at index 0 landed at segs[0] (even/plain) and the callers's
 *  `i % 2 === 1` check highlighted the wrong half of the line (bug: "hello" at the start of a
 *  message rendered unhighlighted while the rest of the line lit up). */
export function highlightSegments(snippet: string, term: string): string[] | null {
  const t = term.trim()
  if (!t || !snippet) return null
  const lower = snippet.toLowerCase()
  const needle = t.toLowerCase()
  if (!lower.includes(needle)) return null
  // Strict alternation: push a plain segment (possibly "" — e.g. a leading match) before EVERY
  // match, then the match itself. This guarantees even index = plain, odd index = match,
  // regardless of where matches fall. The final trailing plain segment is only pushed when
  // non-empty (a match at the very end needs no empty tail); the LEADING one is always pushed,
  // even empty, since that's the parity the caller depends on.
  const out: string[] = []
  let i = 0
  for (;;) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      if (snippet.slice(i)) out.push(snippet.slice(i))
      break
    }
    out.push(snippet.slice(i, at))
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

/** Remove one entry from the recent-search list (exact match). Pure — no-op if absent. */
export function removeRecentSearch(list: string[], query: string): string[] {
  return list.filter((x) => x !== query)
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

// ---- filter chips (WS-F) ---------------------------------------------------
// The parsed query → chip reducer. Each chip carries a `removeQuery(currentQuery)` that returns the
// raw query string with that operator token removed; the component calls `setQuery` with the result
// and the existing debounce effect re-runs the search. Free-text and other operators are preserved.
//
// `stripOperator` is regex-based rather than re-tokenising: the parser already validated the token,
// so we know it exists in one of the two handled shapes (`op:value` or `op:"quoted value"`). The
// ponytail: a malicious query like `from:foo from:foo` collapses to one filter (parser keeps the
// last), so removing the chip leaves the second token intact — but that's a degenerate input and
// the resulting search still has no `from` filter (parser dedupes again on re-parse), so the
// observable behaviour is correct. Upgrade path: re-tokenise via the shared parser and re-emit.

/** Escape RegExp metacharacters in a literal value so it can be embedded in a `RegExp`. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Remove the first `op:value` token from `query` (case-insensitive on the operator), accepting
 * either the bare or the double-quoted value form. Collapses the trailing whitespace so we don't
 * leave a double-space. Returns the trimmed result; never returns empty padding.
 */
export function stripOperator(query: string, op: string, value: string): string {
  if (!op || !value) return query
  const escValue = reEscape(value)
  const re = new RegExp(`\\s*\\b${reEscape(op)}:\\s*(?:"${escValue}"|${escValue})(?=\\s|$)`, "i")
  return query.replace(re, "").trim()
}

/** Format an epoch-ms timestamp as the chip label. UTC YYYY-MM-DD — matches the parser's date
 *  interpretation (bare year and ISO dates are parsed in UTC by `parseDate`). */
export function formatDateChip(ts: number): string {
  if (!Number.isFinite(ts)) return ""
  return new Date(ts).toISOString().slice(0, 10)
}

export interface FilterChip {
  /** Stable identity for React `key` — `${op}:${value}`. */
  key: string
  /** Human label, e.g. `from: Ann`, `after: 2026-07-01`, `has: link`, `mentions: me`. */
  label: string
  /** Strip this operator from the raw query string; the component feeds the result to `setQuery`. */
  removeQuery: (currentQuery: string) => string
}

/** Reduce a parsed query's filters to a list of removable chips. Free text has no chip — it stays
 *  in the input. Each `has:` entry becomes its own chip (Slack-style). */
export function filterChips(parsed: ParsedQuery): FilterChip[] {
  const f = parsed.filters
  const chips: FilterChip[] = []
  if (f.from) {
    const value = f.from
    chips.push({
      key: `from:${value}`,
      label: `from: ${value}`,
      removeQuery: (q) => stripOperator(q, "from", value),
    })
  }
  if (f.in) {
    const value = f.in
    chips.push({
      key: `in:${value}`,
      label: `in: ${value}`,
      removeQuery: (q) => stripOperator(q, "in", value),
    })
  }
  if (typeof f.afterTs === "number") {
    const value = formatDateChip(f.afterTs)
    if (value) {
      chips.push({
        key: `after:${value}`,
        label: `after: ${value}`,
        // The parser keeps only the last `after:` token, so there's exactly one to remove —
        // strip the first `after:<...>` token regardless of how the user spelled the date
        // (the chip label is the normalised YYYY-MM-DD, which may differ from their input).
        removeQuery: (q) => stripFirstToken(q, "after"),
      })
    }
  }
  if (typeof f.beforeTs === "number") {
    const value = formatDateChip(f.beforeTs)
    if (value) {
      chips.push({
        key: `before:${value}`,
        label: `before: ${value}`,
        removeQuery: (q) => stripFirstToken(q, "before"),
      })
    }
  }
  if (Array.isArray(f.has)) {
    for (const h of f.has) {
      const value = h
      chips.push({
        key: `has:${value}`,
        label: `has: ${value}`,
        removeQuery: (q) => stripOperator(q, "has", value),
      })
    }
  }
  if (f.mentionsMe) {
    chips.push({
      key: "mentions:me",
      label: "mentions: me",
      removeQuery: (q) => stripOperator(q, "mentions", "me"),
    })
  }
  return chips
}

/** True when the parsed query has at least one filter (any chip would render). */
export function hasFilters(parsed: ParsedQuery | undefined | null): boolean {
  if (!parsed) return false
  const f = parsed.filters
  return Boolean(
    f.from ||
      f.in ||
      typeof f.afterTs === "number" ||
      typeof f.beforeTs === "number" ||
      (Array.isArray(f.has) && f.has.length > 0) ||
      f.mentionsMe,
  )
}

/** Strip the first `op:<token>` token (any value, quoted or bare). Used by date chips where the
 *  user's original spelling isn't recoverable from the parsed ts — there is only ever one such
 *  token (parser keeps the last), so first-match-wins is correct. Returns trimmed query. */
function stripFirstToken(query: string, op: string): string {
  const re = new RegExp(`\\s*\\b${reEscape(op)}:\\s*(?:"[^"]+"|[^\\s]+)`, "i")
  return query.replace(re, "").trim()
}

// ---- sort + scope (WS-F) ---------------------------------------------------

export type SearchSort = "relevance" | "recent"

/** Sort order options, in toggle order. */
export const SORTS: readonly SearchSort[] = ["relevance", "recent"]
export const DEFAULT_SORT: SearchSort = "relevance"

/** localStorage key for the persisted sort choice (chat-scoped). */
export const SEARCH_SORT_KEY = "chat:search-sort"

/** Structural scope kinds surfaced as a segmented control. `folder`/`label` need a picker
 *  (conversation_prefs) and are deferred — the chip row only shows these three for v1. */
export const SCOPE_KINDS = ["all", "dm", "group"] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]
export const DEFAULT_SCOPE_KIND: ScopeKind = "all"

/** Tolerant parse of a stored sort value. Falls back to the default on anything unexpected. */
export function parseSort(raw: string | null | undefined): SearchSort {
  return raw === "recent" || raw === "relevance" ? raw : DEFAULT_SORT
}
