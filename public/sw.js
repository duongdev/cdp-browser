// Minimal service worker for the web build — enables PWA install and offline shell.
// Navigations are network-first (so Authentik redirects + the live title work, with a
// cached fallback offline); hashed static assets are cache-first. The API surface
// (SSE event stream, streaming input upload, POSTs) and non-GET requests are NEVER
// intercepted — they must always hit the network. See t011.

// Per-build cache name: the registration passes the build identity as `?v=<version>-<sha>`
// (main.tsx, from the Vite __APP_VERSION__/__GIT_SHA__ define). A new build => a new script
// URL => the browser installs a fresh worker that waits. Mirrors cacheNameFor/isStaleCache
// in src/lib/sw-cache-name.ts (static SW can't import it). See t044.
const PREFIX = "cdp-portal-"
const CACHE = PREFIX + (new URL(self.location).searchParams.get("v") || "unknown")

// No unconditional skipWaiting — the new worker waits until the page opts in via the
// SKIP_WAITING message (driven by the in-app "Update available" toast).
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)),
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
      source: data.source,
      title: data.title,
      body: data.body,
      targetId: data.targetId,
      targetUrl: data.targetUrl,
      targetEntity: data.targetEntity,
      adapter: data.adapter,
      groupKey: data.groupKey,
      activate: data.activate,
      ts: data.ts,
      // Conversation identity for the reader deep-route + composer (t080).
      channelId: data.channelId,
      slackKind: data.slackKind,
      slackTs: data.slackTs,
      slackThreadTs: data.slackThreadTs,
    },
  }
  const work = [self.registration.showNotification(title, options)]
  // Home-screen badge mirror (t080): the server stamps the unread count on every push,
  // so the icon is glanceable without opening the app. Feature-detected (iOS 16.4+).
  if (typeof data.unread === "number" && navigator.setAppBadge) {
    work.push(
      (data.unread > 0
        ? navigator.setAppBadge(data.unread)
        : (navigator.clearAppBadge?.() ?? Promise.resolve())
      ).catch(() => {}),
    )
  }
  e.waitUntil(Promise.all(work))
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
      // Cold start (t080): no window exists, so postMessage has no receiver. Carry the
      // entry id in the URL; the app consumes `?notif=` on boot and opens the reader.
      if (self.clients.openWindow)
        return self.clients.openWindow(
          notifData.id ? `/?notif=${encodeURIComponent(notifData.id)}` : "/",
        )
    }),
  )
})

// Push subscription change handler — fires when the push service rotates or revokes a
// subscription (e.g., after a period of inactivity, or when the device re-registers).
// Notifies the page so it can re-subscribe with the current VAPID key (which the page has).
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsArr) => {
        for (const client of clientsArr) {
          client.postMessage({ type: "push-subscription-change" })
        }
      })
      .catch((err) => console.error("[sw] pushsubscriptionchange notify failed:", err)),
  )
})
