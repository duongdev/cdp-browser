import { describe, expect, it } from "vitest"
// Server-side AES-256-GCM envelope (node:crypto), shared with web/server.mjs.
import { deriveKey, open, seal } from "./crypto-envelope"
// Browser twin (WebCrypto) — runs here since Node backs globalThis.crypto.
import { open as webOpen, seal as webSeal } from "./src/lib/crypto-envelope"

const SALT = Buffer.from("0123456789abcdef").toString("base64")
const key = deriveKey("correct horse battery staple", SALT, 10000)
const wrong = deriveKey("wrong passphrase", SALT, 10000)

describe("crypto-envelope (node)", () => {
  it("round-trips an object through seal → open", () => {
    const obj = { method: "Input.dispatchMouseEvent", params: { x: 12, y: 34 } }
    expect(open(seal(obj, key), key)).toEqual(obj)
  })

  it("throws when opened with the wrong key (GCM auth fails)", () => {
    const sealed = seal({ secret: "screen frame" }, key)
    expect(() => open(sealed, wrong)).toThrow()
  })

  it("uses a fresh IV each call (same plaintext → different ciphertext)", () => {
    const obj = { a: 1 }
    expect(seal(obj, key)).not.toEqual(seal(obj, key))
  })

  it("rejects tampered ciphertext", () => {
    const sealed = seal({ a: 1 }, key)
    const buf = Buffer.from(sealed, "base64")
    buf[buf.length - 1] ^= 0xff // flip a tag byte
    expect(() => open(buf.toString("base64"), key)).toThrow()
  })

  it("is wire-compatible with the browser WebCrypto twin (same derived key)", async () => {
    const webKey = await globalThis.crypto.subtle.importKey("raw", key, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
    const obj = { method: "Page.navigate", params: { url: "https://example.com" } }
    expect(open(await webSeal(obj, webKey), key)).toEqual(obj) // browser seals → server opens
    expect(await webOpen(seal(obj, key), webKey)).toEqual(obj) // server seals → browser opens
  })
})
