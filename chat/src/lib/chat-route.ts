// URL routing for the chat app (t150). The path IS the state: `/chat/` is the list, `/chat/c/{id}`
// is an open conversation (id is a Teams thread id like `19:...@thread.v2`, URL-encoded), and
// `/chat/search` is the full-screen global message search (PSN-115 WS-E). No router lib —
// chat-app.tsx reads parsePath/parseSearchPath on boot + popstate and pushes pathFor on switch.

const PREFIX = "/chat/c/"
export const SEARCH_PATH = "/chat/search"

export function parsePath(pathname: string): { convId: string } | null {
  if (!pathname.startsWith(PREFIX)) return null
  const raw = pathname.slice(PREFIX.length)
  if (!raw) return null
  try {
    return { convId: decodeURIComponent(raw) }
  } catch {
    return null
  }
}

export function isSearchPath(pathname: string): boolean {
  // Exact match only — `/chat/search/` or any sub-path is not the search surface.
  return pathname === SEARCH_PATH
}

export function pathFor(convId: string | null): string {
  return convId ? PREFIX + encodeURIComponent(convId) : "/chat/"
}

/** `q`/`sort`/`scope` ride as URL search params on `/chat/search` — a refresh (or a shared link)
 *  restores the search state instead of dropping back to empty. `sort`/`scope` are omitted when
 *  at their default so a plain query keeps a clean URL. */
export interface SearchUrlState {
  q?: string
  sort?: "relevance" | "recent"
  scope?: "all" | "dm" | "group"
}

export function pathForSearch(state?: SearchUrlState): string {
  if (!state) return SEARCH_PATH
  const params = new URLSearchParams()
  if (state.q) params.set("q", state.q)
  if (state.sort && state.sort !== "relevance") params.set("sort", state.sort)
  if (state.scope && state.scope !== "all") params.set("scope", state.scope)
  const qs = params.toString()
  return qs ? `${SEARCH_PATH}?${qs}` : SEARCH_PATH
}

/** Parse `q`/`sort`/`scope` back out of a `/chat/search?...` URL's search string. Defensive — a
 *  garbage `sort`/`scope` value falls back to undefined (the caller's default) rather than
 *  propagating an invalid enum into state. */
export function parseSearchUrlState(search: string): SearchUrlState {
  const params = new URLSearchParams(search)
  const q = params.get("q") ?? undefined
  const rawSort = params.get("sort")
  const sort = rawSort === "recent" ? "recent" : undefined
  const rawScope = params.get("scope")
  const scope = rawScope === "dm" || rawScope === "group" ? rawScope : undefined
  return { q, sort, scope }
}
