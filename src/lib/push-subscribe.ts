// Effectful web-build push subscription helpers (t099, C1). The pure decisions live in
// push-lifecycle.ts; these wrap the browser PushManager + the server register/unregister
// calls behind a DI seam so app.tsx (boot reconcile, foreground revalidate, SW-message
// recovery) and settings-dialog.tsx (toggle, on-open revalidate) share one implementation.
// Kept out of the components so the subscribe wiring is unit-testable with fakes.

export interface PushSubscribeDeps {
  // `navigator.serviceWorker?.ready`
  swReady(): Promise<ServiceWorkerRegistration | null | undefined>
  // `window.cdp.getPushVapidKey?.()`
  getVapidKey(): Promise<string | null | undefined>
  // `window.cdp.subscribePush(sub)` — POSTs to the server, which reconciles + returns deviceId.
  registerSubscription(sub: PushSubscriptionJSON): Promise<{ deviceId: string }>
  // `window.cdp.unsubscribePush(endpoint)`
  unregisterSubscription(endpoint: string): Promise<unknown>
}

// VAPID public key is delivered as URL-safe base64 by the server; pushManager.subscribe
// expects a raw ArrayBuffer. Standard helper from the Web Push spec.
export function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  const buf = new ArrayBuffer(rawData.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < rawData.length; i++) view[i] = rawData.charCodeAt(i)
  return buf
}

// Adapter binding the deps to the live browser globals + the web `window.cdp` bridge.
// The single place that knows the bridge method names; components/app.tsx call it.
export function createBrowserPushDeps(): PushSubscribeDeps {
  return {
    swReady: () => navigator.serviceWorker?.ready ?? Promise.resolve(null),
    getVapidKey: () => window.cdp.getPushVapidKey?.() ?? Promise.resolve(null),
    registerSubscription: (sub) =>
      window.cdp.subscribePush?.(sub) ?? Promise.reject(new Error("subscribePush unavailable")),
    unregisterSubscription: (endpoint) =>
      window.cdp.unsubscribePush?.(endpoint) ?? Promise.resolve(),
  }
}

// The current push subscription, without creating one — the boot-planning input.
export async function getExistingSubscription(
  deps: PushSubscribeDeps,
): Promise<PushSubscription | null> {
  const reg = await deps.swReady()
  return (await reg?.pushManager.getSubscription()) ?? null
}

// Ensure a live subscription exists and is registered with the server. pushManager.subscribe
// is idempotent (returns the existing sub when already subscribed), so this doubles as
// subscribe (fresh) and re-validate (recover rotation/revocation). Returns the server's
// reconciled { deviceId }, or null when the environment can't subscribe (no SW / no key).
export async function ensurePushSubscription(
  deps: PushSubscribeDeps,
): Promise<{ deviceId: string } | null> {
  const reg = await deps.swReady()
  if (!reg) return null
  const key = await deps.getVapidKey()
  if (!key) return null
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(key),
  })
  return deps.registerSubscription(sub.toJSON() as PushSubscriptionJSON)
}

// Tear down the live subscription both server-side (drop the record) and in the browser.
export async function removePushSubscription(deps: PushSubscribeDeps): Promise<void> {
  const reg = await deps.swReady()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await deps.unregisterSubscription(sub.endpoint)
  await sub.unsubscribe()
}
