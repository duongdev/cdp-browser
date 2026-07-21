// Minimal service worker for the Teams chat app (t106, ADR-0018). Its scope is `/chat/`
// (the script path's directory), so it never touches the browser PWA's SW at `/`.
// Navigations are network-first with a cached `/chat/` shell fallback; same-origin static
// assets are cache-first. The API surface and non-GET requests always hit the network.

const CACHE = "teams-chat-v1"
const SHELL = "/chat/"

self.addEventListener("install", () => self.skipWaiting())

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith("teams-chat-") && n !== CACHE)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  ),
)

self.addEventListener("fetch", (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return // pass through to network

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(SHELL).then((r) => r || Response.error())))
    return
  }

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok && url.origin === self.location.origin) cache.put(req, res.clone())
      return res
    }),
  )
})
