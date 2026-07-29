// Pure helpers for the search-box KQL suggestion dropdown (PSN-115 follow-up). The search input is
// a plain `<input>`, not Tiptap, so the composer's Mention-suggestion plugin can't be reused —
// these detect the operator token under the caret (`from`/`in`/`after`/`before`/`has`) and rewrite
// the query when a suggestion is picked. Pure (no React, no I/O) so the caret math + the rewrite
// are unit-testable in isolation.

/** The operators that get a suggestion dropdown. `mentions:me` is a flag (no value) so it's
 *  excluded. */
export const SUGGESTIBLE_OPS = ["from", "in", "after", "before", "has"] as const

/** The active suggestion: which operator, the partial text typed after its colon, and the
 *  [start, end) range in the query string to replace when a suggestion is picked. */
export interface SuggestionRange {
  kind: (typeof SUGGESTIBLE_OPS)[number]
  /** The partial text after `op:`, minus any opening quote (so "from:an" → "an", `from:"an` → "an").
   *  Used to filter the suggestion list, or to seed the date picker. */
  partial: string
  /** Replace [start, end) in the query with the picked value (built by `applySuggestion`). */
  start: number
  end: number
  /** True when the partial opened with a quote — `applySuggestion` re-quotes multi-word values. */
  quoted: boolean
}

/** Scan `query` up to `caret` for an open operator token whose value is still being typed.
 *  Returns null when the caret isn't inside one, or the token was already closed (a bare value
 *  ended by a space, or a quoted value ended by its closing quote). A quoted value stays open
 *  across spaces until the closing quote lands. The caret is clamped to [0, length]. */
export function detectSuggestion(query: string, caret: number): SuggestionRange | null {
  const c = Math.max(0, Math.min(caret, query.length))
  const before = query.slice(0, c)
  // The last suggestible `op:` preceded by start-of-string or whitespace (so `join:` doesn't match).
  const m = /(?:^|\s)(from|in|after|before|has):/.exec(before)
  if (!m) return null
  const kind = m[1] as SuggestionRange["kind"]
  const opStart = m.index === 0 ? 0 : (m.index ?? 0) + 1
  const valueStart = opStart + kind.length + 1 // past the `op:`
  const value = before.slice(valueStart)
  if (value === "") {
    // Bare `op:` with nothing after yet — open, empty partial.
    return { kind, partial: "", start: opStart, end: c, quoted: false }
  }
  if (value.startsWith('"')) {
    // Quoted: open until a closing quote. A closing quote present → closed → no suggestion.
    const close = value.indexOf('"', 1)
    if (close !== -1) return null
    return { kind, partial: value.slice(1), start: opStart, end: c, quoted: true }
  }
  // Bare: a space ends it (the regex's leading-boundary requirement means the value itself has no
  // leading space, but it could contain a space if the caret moved — guard anyway).
  if (/\s/.test(value)) return null
  return { kind, partial: value, start: opStart, end: c, quoted: false }
}

/** Build the replacement text for a picked suggestion and splice it into the query.
 *  Embedded quotes are stripped from the value first; the result is quoted ONLY if it still has a
 *  space (multi-word) so the parser keeps it as one token — single-word values stay bare. A
 *  trailing space is appended ONLY when the caret was at the end of the query (the common case)
 *  so the user can keep typing free text; editing mid-query preserves whatever follows. Returns
 *  the new query string + the caret offset to land just after the inserted token. */
export function applySuggestion(
  query: string,
  range: SuggestionRange,
  /** The display value to insert (a person's name or a conversation title). */
  value: string,
): { value: string; caret: number } {
  const escaped = value.replace(/"/g, "")
  const needsQuotes = /\s/.test(escaped)
  const token = needsQuotes ? `${range.kind}:"${escaped}"` : `${range.kind}:${escaped}`
  const atEnd = range.end >= query.length
  const sep = atEnd ? " " : ""
  const next = `${query.slice(0, range.start)}${token}${sep}${query.slice(range.end)}`
  // Caret lands just after the token (before the trailing space when at-end, or at the token end
  // mid-query — the existing text follows).
  return { value: next, caret: range.start + token.length }
}
