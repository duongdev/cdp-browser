// @-mention candidate filtering for the composer dropdown (PSN-92 D). Pure — the DOM insertion +
// caret handling live in the composer; this only ranks roster members against the typed query.
import { fold } from "@/lib/fold-text"
import type { RosterMember } from "./teams-client"

/** The `@query` fragment immediately before the caret, or null when the caret isn't in a mention.
 *  A mention starts at `@` that is at the string start or preceded by whitespace (so an email's `@`
 *  never triggers it); the query runs to the caret and may not contain whitespace. `textBeforeCaret`
 *  is the plain text of the current line/segment up to the caret. */
export function mentionQuery(textBeforeCaret: string): { query: string; at: number } | null {
  const m = textBeforeCaret.match(/(^|\s)@([^\s@]*)$/)
  if (!m) return null
  // Index of the `@` itself (after the optional leading space group).
  const at = m.index! + m[1].length
  return { query: m[2], at }
}

/** Rank roster members against a query (diacritic/case-insensitive). Empty query → everyone (name
 *  order). A match requires every whitespace-token of the query to be a prefix of some name token OR
 *  the whole query to be a substring of the folded name; a name-token prefix hit ranks above a loose
 *  substring hit. Self is included (Teams shows it too). Capped to `limit`. */
export function filterRoster(members: RosterMember[], query: string, limit = 8): RosterMember[] {
  const q = fold(query.trim())
  if (!q) return members.slice().sort(byName).slice(0, limit)
  const scored: { m: RosterMember; score: number }[] = []
  for (const m of members) {
    const name = fold(m.name)
    if (!name) continue
    const tokens = name.split(/\s+/)
    let score = -1
    if (tokens.some((t) => t.startsWith(q)))
      score = 0 // a name word starts with the query — best
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    if (score >= 0) scored.push({ m, score })
  }
  scored.sort((a, b) => a.score - b.score || byName(a.m, b.m))
  return scored.slice(0, limit).map((s) => s.m)
}

function byName(a: RosterMember, b: RosterMember): number {
  return a.name.localeCompare(b.name)
}
