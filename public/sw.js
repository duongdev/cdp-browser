// Minimal service worker for the web build — enables PWA install and offline shell.
// Navigations are network-first (so Authentik redirects + the live title work, with a
// cached fallback offline); hashed static assets are cache-first. The API surface
// (SSE event stream, streaming input upload, POSTs) and non-GET requests are NEVER
// intercepted — they must always hit the network. See t011.
const CACHE = "cdp-portal-v1"

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()))

self.addEventListener("fetch", (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return // pass through to network

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/").then((r) => r || Response.error())))
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
