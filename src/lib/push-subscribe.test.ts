import { describe, expect, it, vi } from "vitest"
import {
  ensurePushSubscription,
  getExistingSubscription,
  type PushSubscribeDeps,
  removePushSubscription,
  urlBase64ToArrayBuffer,
} from "./push-subscribe"

function fakeSub(endpoint = "https://push.example/ep") {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "k", auth: "a" } }),
    unsubscribe: vi.fn(async () => true),
  }
}

function fakeReg(sub: ReturnType<typeof fakeSub> | null) {
  return {
    pushManager: {
      getSubscription: vi.fn(async () => sub),
      subscribe: vi.fn(async () => sub ?? fakeSub()),
    },
  }
}

function deps(over: Partial<PushSubscribeDeps> = {}): PushSubscribeDeps {
  return {
    swReady: async () => fakeReg(fakeSub()) as unknown as ServiceWorkerRegistration,
    getVapidKey: async () => "dGVzdA",
    registerSubscription: vi.fn(async () => ({ deviceId: "D1" })),
    unregisterSubscription: vi.fn(async () => ({ ok: true })),
    ...over,
  }
}

describe("urlBase64ToArrayBuffer", () => {
  it("decodes url-safe base64 to a byte buffer", () => {
    const buf = urlBase64ToArrayBuffer("dGVzdA") // "test"
    expect(Array.from(new Uint8Array(buf))).toEqual([116, 101, 115, 116])
  })
})

describe("ensurePushSubscription", () => {
  it("subscribes and registers the subscription JSON, returning the server deviceId", async () => {
    const register = vi.fn(async () => ({ deviceId: "D9" }))
    const d = deps({ registerSubscription: register })

    const result = await ensurePushSubscription(d)

    expect(register).toHaveBeenCalledWith({
      endpoint: "https://push.example/ep",
      keys: { p256dh: "k", auth: "a" },
    })
    expect(result).toEqual({ deviceId: "D9" })
  })

  it("returns null when no service worker registration is available", async () => {
    const result = await ensurePushSubscription(deps({ swReady: async () => null }))
    expect(result).toBeNull()
  })

  it("returns null when the VAPID key is missing", async () => {
    const result = await ensurePushSubscription(deps({ getVapidKey: async () => null }))
    expect(result).toBeNull()
  })
})

describe("getExistingSubscription", () => {
  it("returns the live subscription without creating one", async () => {
    const sub = fakeSub()
    const d = deps({ swReady: async () => fakeReg(sub) as unknown as ServiceWorkerRegistration })

    const result = await getExistingSubscription(d)

    expect(result).toBe(sub)
  })

  it("returns null when there is no subscription", async () => {
    const d = deps({ swReady: async () => fakeReg(null) as unknown as ServiceWorkerRegistration })
    expect(await getExistingSubscription(d)).toBeNull()
  })
})

describe("removePushSubscription", () => {
  it("unregisters server-side and unsubscribes in the browser", async () => {
    const sub = fakeSub("https://push.example/gone")
    const unregister = vi.fn(async () => ({ ok: true }))
    const d = deps({
      swReady: async () => fakeReg(sub) as unknown as ServiceWorkerRegistration,
      unregisterSubscription: unregister,
    })

    await removePushSubscription(d)

    expect(unregister).toHaveBeenCalledWith("https://push.example/gone")
    expect(sub.unsubscribe).toHaveBeenCalled()
  })

  it("no-ops when there is no subscription", async () => {
    const unregister = vi.fn(async () => ({ ok: true }))
    const d = deps({
      swReady: async () => fakeReg(null) as unknown as ServiceWorkerRegistration,
      unregisterSubscription: unregister,
    })

    await removePushSubscription(d)

    expect(unregister).not.toHaveBeenCalled()
  })
})
