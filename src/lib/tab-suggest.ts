// Pure New Tab omnibox matcher (t103, ADR-0012 sibling; ADR-0017). Merges the
// server's browsing history with the currently-open tabs into one ranked
// suggestion list: an open tab wins as a "switch" row (avoid opening a duplicate),
// history matches follow, frecency-ranked. Mirrors core/history-store.js ranking
// (the renderer can't import that CJS module). Diacritic-safe via fold-text.
import { fold } from "./fold-text"

export type HistoryEntry = {
  url: string
  title: string
  visitCount: number
  lastVisit: number
}

export type OpenTab = {
  kind: "cdp" | "local"
  id: string
  title: string
  url: string
}

export type Suggestion =
  | { kind: "switch"; tabKind: "cdp" | "local"; id: string; title: string; url: string }
  | { kind: "history"; title: string; url: string }

const DAY = 24 * 3600_000

function frecency(entry: HistoryEntry, now: number): number {
  const ageDays = Math.max(0, now - entry.lastVisit) / DAY
  return entry.visitCount * (1 / (1 + ageDays))
}

function matches(query: string, ...fields: string[]): boolean {
  return fields.some((f) => fold(f).includes(query))
}

// Suggestions for the New Tab omnibox. Empty query returns nothing — the dialog
// shows pinned quick-launch for that state. Otherwise: matching open tabs first
// (as switch rows), then history matches (frecency-ranked, deduped against the
// open-tab urls). Capped to `limit`.
export function suggest(args: {
  query: string
  history: HistoryEntry[]
  openTabs: OpenTab[]
  now: number
  limit: number
}): Suggestion[] {
  const q = fold(args.query.trim())
  if (!q) return []

  const switches: Suggestion[] = args.openTabs
    .filter((t) => matches(q, t.title, t.url))
    .map((t) => ({ kind: "switch", tabKind: t.kind, id: t.id, title: t.title, url: t.url }))

  const openUrls = new Set(args.openTabs.map((t) => t.url))
  const histRows: Suggestion[] = args.history
    .filter((h) => !openUrls.has(h.url) && matches(q, h.title, h.url))
    .sort((a, b) => frecency(b, args.now) - frecency(a, args.now))
    .map((h) => ({ kind: "history", title: h.title, url: h.url }))

  return [...switches, ...histRows].slice(0, args.limit)
}
