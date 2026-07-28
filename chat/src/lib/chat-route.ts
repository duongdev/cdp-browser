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

export function pathForSearch(): string {
  return SEARCH_PATH
}
