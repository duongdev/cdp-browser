import { describe, expect, it, vi } from "vitest"
import {
  type ChatPushDeps,
  ensureChatPushSubscription,
  removeChatPushSubscription,
  urlBase64ToArrayBuffer,
} from "./chat-push"

describe("urlBase64ToArrayBuffer", () => {
  it("decodes standard base64 to the right bytes", () => {
    // "hi" → base64 "aGk="
    const buf = urlBase64ToArrayBuffer("aGk=")
    expect([...new Uint8Array(buf)]).toEqual([0x68, 0x69])
  })

  it("pads a length not divisible by 4", () => {
    // "aGk" (no padding) must decode identically to "aGk="
    expect([...new Uint8Array(urlBase64ToArrayBuffer("aGk"))]).toEqual([0x68, 0x69])
  })

  it("translates URL-safe chars (- _) back to (+ /)", () => {
    // Byte 0xFB,0xFF → "+/8" in standard base64, "-_8" URL-safe. Both must decode equal.
    const std = [...new Uint8Array(urlBase64ToArrayBuffer("+/8="))]
    const urlSafe = [...new Uint8Array(urlBase64ToArrayBuffer("-_8="))]
    expect(urlSafe).toEqual(std)
    expect(urlSafe).toEqual([0xfb, 0xff])
  })
})

// Minimal fake sub + registration so the effectful helpers run without a browser.
function fakeDeps(existing: { endpoint: string } | null) {
  const created = { endpoint: "https://push/new", toJSON: () => ({ endpoint: "https://push/new" }) }
  const unsubscribe = vi.fn().mockResolvedValue(true)
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing ? { ...existing, unsubscribe } : null),
    subscribe: vi.fn().mockResolvedValue(created),
  }
  const deps: ChatPushDeps = {
    swReady: vi.fn().mockResolvedValue({ pushManager }),
    getVapidKey: vi.fn().mockResolvedValue("aGk"),
    registerSubscription: vi.fn().mockResolvedValue(undefined),
    unregisterSubscription: vi.fn().mockResolvedValue(undefined),
  }
  return { deps, pushManager, unsubscribe }
}

describe("ensureChatPushSubscription", () => {
  it("subscribes and registers with the server", async () => {
    const { deps } = fakeDeps(null)
    const sub = await ensureChatPushSubscription(deps)
    expect(sub).not.toBeNull()
    expect(deps.registerSubscription).toHaveBeenCalledWith({ endpoint: "https://push/new" })
  })

  it("returns null (no subscribe) when the VAPID key is unavailable", async () => {
    const { deps, pushManager } = fakeDeps(null)
    ;(deps.getVapidKey as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    expect(await ensureChatPushSubscription(deps)).toBeNull()
    expect(pushManager.subscribe).not.toHaveBeenCalled()
  })
})

describe("removeChatPushSubscription", () => {
  it("unregisters server-side and unsubscribes the browser sub", async () => {
    const { deps, unsubscribe } = fakeDeps({ endpoint: "https://push/old" })
    await removeChatPushSubscription(deps)
    expect(deps.unregisterSubscription).toHaveBeenCalledWith("https://push/old")
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("no-ops when there is no live subscription", async () => {
    const { deps } = fakeDeps(null)
    await removeChatPushSubscription(deps)
    expect(deps.unregisterSubscription).not.toHaveBeenCalled()
  })
})
