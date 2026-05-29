import { describe, expect, it } from "vitest"
import { createCryptoContext } from "./crypto-context"
import { deriveKey, open as envOpen, seal as envSeal } from "./crypto-envelope"

const SALT = btoa("0123456789abcdef")

describe("crypto-context — off mode", () => {
  it("is always ready and serializes plaintext JSON", async () => {
    const ctx = createCryptoContext({ mode: "off" })
    expect(ctx.mode).toBe("off")
    expect(ctx.ready).toBe(true)
    const text = await ctx.sealText({ a: 1, b: "x" })
    expect(text).toBe(JSON.stringify({ a: 1, b: "x" }))
    expect(await ctx.openText(text)).toEqual({ a: 1, b: "x" })
  })

  it("reports plaintext content-type (application/json)", () => {
    const ctx = createCryptoContext({ mode: "off" })
    expect(ctx.contentType).toBe("application/json")
  })
})

describe("crypto-context — e2e mode", () => {
  it("seals through AES-256-GCM and round-trips back to the original object", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const ctx = createCryptoContext({ mode: "e2e", key })
    const obj = { method: "Page.navigate", params: { url: "https://x" } }
    const sealed = await ctx.sealText(obj)
    // Byte-identical wire: the context seal must decode with the bare envelope.
    expect(await envOpen(sealed, key)).toEqual(obj)
    // And the context can open what the envelope sealed.
    const fromEnvelope = await envSeal(obj, key)
    expect(await ctx.openText(fromEnvelope)).toEqual(obj)
  })

  it("round-trips a batch and an input frame", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const ctx = createCryptoContext({ mode: "e2e", key })
    const batch = { seq: 3, items: [{ method: "Input.dispatchMouseEvent", params: { x: 1 } }] }
    expect(await ctx.openText(await ctx.sealText(batch))).toEqual(batch)
    const frame = { method: "Page.screencastFrame", params: { data: "jpeg", sessionId: 7 } }
    expect(await ctx.openText(await ctx.sealText(frame))).toEqual(frame)
  })

  it("reports sealed content-type (text/plain)", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const ctx = createCryptoContext({ mode: "e2e", key })
    expect(ctx.contentType).toBe("text/plain")
  })

  it("starts ready by default (handshake already confirmed at build) and can gate", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    expect(createCryptoContext({ mode: "e2e", key }).ready).toBe(true)
    const gated = createCryptoContext({ mode: "e2e", key, ready: false })
    expect(gated.ready).toBe(false)
    gated.confirm()
    expect(gated.ready).toBe(true)
  })
})
