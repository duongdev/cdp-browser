// Minimal service worker for the Teams chat app (t128, ADR-0019). Its scope is `/chat/`
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

// Web Push (t147). The server sends the ADR-0019 payload
// { type, title, body, convId, msgId, ts, tag }. iOS revokes a userVisibleOnly subscription
// that receives a push without showing a notification, so ALWAYS showNotification — a generic
// fallback on any parse failure.
self.addEventListener("push", (e) => {
  e.waitUntil(
    (async () => {
      let p = null
      try {
        p = e.data?.json() ?? null
      } catch {
        p = null
      }
      const title = p?.title || "New message"
      await self.registration.showNotification(title, {
        body: p?.body || "",
        tag: p?.tag || "teams-chat",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { convId: p?.convId || null },
      })
    })(),
  )
})

// Click: focus an open /chat window and deep-route via postMessage (warm tap); else open the
// app with ?conv= for the page to consume on boot (cold tap).
self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const convId = e.notification.data?.convId || null
  e.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const client of clientsArr) {
        if ("focus" in client) {
          client.postMessage({ type: "open-conv", convId })
          return client.focus()
        }
      }
      // Cold tap: deep-link straight to the conversation's route (t155, workstream I's URL scheme).
      // chat-app boots from the path; an unknown id degrades to the list.
      if (self.clients.openWindow)
        return self.clients.openWindow(convId ? `/chat/c/${encodeURIComponent(convId)}` : "/chat/")
    })(),
  )
})
