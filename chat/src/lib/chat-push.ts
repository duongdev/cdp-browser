// Web Push subscribe helpers for the Teams chat PWA (t147). Ports the pushManager.subscribe +
// register-with-server dance from src/lib/push-subscribe.ts (chat/ can't import from src/), against
// the /api/teams/push/* endpoints. Effects sit behind a DI seam so the toggle is unit-testable.

export interface ChatPushDeps {
  // `navigator.serviceWorker?.ready`
  swReady(): Promise<ServiceWorkerRegistration | null | undefined>
  // GET /api/teams/push/vapid-public-key → URL-safe base64 key (null when unavailable).
  getVapidKey(): Promise<string | null>
  // POST /api/teams/push/subscribe
  registerSubscription(sub: PushSubscriptionJSON): Promise<void>
  // POST /api/teams/push/unsubscribe
  unregisterSubscription(endpoint: string): Promise<void>
}

// VAPID public key arrives as URL-safe base64; pushManager.subscribe wants a raw ArrayBuffer.
// Standard helper from the Web Push spec.
export function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  const buf = new ArrayBuffer(rawData.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < rawData.length; i++) view[i] = rawData.charCodeAt(i)
  return buf
}

export async function getVapidKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/teams/push/vapid-public-key")
    if (!res.ok) return null
    const data = (await res.json()) as { key?: string }
    return typeof data?.key === "string" && data.key ? data.key : null
  } catch {
    return null
  }
}

// Binds the deps to the live browser globals + the /api/teams/push endpoints.
export function createBrowserChatPushDeps(): ChatPushDeps {
  return {
    swReady: () => navigator.serviceWorker?.ready ?? Promise.resolve(null),
    getVapidKey,
    registerSubscription: async (sub) => {
      await fetch("/api/teams/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      })
    },
    unregisterSubscription: async (endpoint) => {
      await fetch("/api/teams/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      })
    },
  }
}

// Is a live push subscription present (without creating one)?
export async function isChatPushSubscribed(
  deps: ChatPushDeps = createBrowserChatPushDeps(),
): Promise<boolean> {
  const reg = await deps.swReady()
  return !!(await reg?.pushManager.getSubscription())
}

// Ensure a subscription exists and is registered with the server. pushManager.subscribe is
// idempotent (returns the existing sub when already subscribed), so this doubles as fresh-subscribe
// and re-validate. Returns the subscription, or null when the environment can't subscribe.
export async function ensureChatPushSubscription(
  deps: ChatPushDeps = createBrowserChatPushDeps(),
): Promise<PushSubscription | null> {
  const reg = await deps.swReady()
  if (!reg) return null
  const key = await deps.getVapidKey()
  if (!key) return null
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(key),
  })
  await deps.registerSubscription(sub.toJSON() as PushSubscriptionJSON)
  return sub
}

// Tear down the subscription server-side (drop the record) and in the browser.
export async function removeChatPushSubscription(
  deps: ChatPushDeps = createBrowserChatPushDeps(),
): Promise<void> {
  const reg = await deps.swReady()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await deps.unregisterSubscription(sub.endpoint)
  await sub.unsubscribe()
}
