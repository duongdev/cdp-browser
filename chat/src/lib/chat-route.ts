// URL routing for the chat app (t150). The path IS the state: `/chat/` is the list, `/chat/c/{id}`
// is an open conversation (id is a Teams thread id like `19:...@thread.v2`, URL-encoded). No router
// lib — chat-app.tsx reads parsePath on boot + popstate and pushes pathFor on switch.

const PREFIX = "/chat/c/"

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

export function pathFor(convId: string | null): string {
  return convId ? PREFIX + encodeURIComponent(convId) : "/chat/"
}
