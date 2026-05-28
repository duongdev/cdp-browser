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

// Web Push handler — fires whenever the push service delivers a notification to this
// device, including when the PWA is backgrounded or the screen is locked. iOS 16.4+
// PWAs only; the payload mirrors what the server's `sendPushToAll` sends.
self.addEventListener("push", (e) => {
  if (!e.data) return
  let data
  try {
    data = e.data.json()
  } catch {
    return
  }
  const title = data.title || "CDP Browser"
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.id || undefined, // collapses repeat notifications with same id
    timestamp: data.ts || Date.now(),
    data: {
      id: data.id,
      targetId: data.targetId,
      targetUrl: data.targetUrl,
      targetEntity: data.targetEntity,
    },
  }
  e.waitUntil(self.registration.showNotification(title, options))
})

// Click handler — focus an existing window or open the app; pass the notification id
// to the page so it can replay the side-channel deep-link (activate tab + navigate).
self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const notifData = e.notification.data || {}
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ("focus" in client) {
          client.postMessage({ type: "notification-click", data: notifData })
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("/")
    }),
  )
})
