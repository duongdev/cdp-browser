import { describe, expect, it } from "vitest"
// Node's WebCrypto backs globalThis.crypto under vitest, so the browser module runs here.
import { deriveKey, open, seal } from "./crypto-envelope"

const SALT = btoa("0123456789abcdef")

describe("crypto-envelope (browser/WebCrypto)", () => {
  it("round-trips an object", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const obj = { kind: "frame", data: "x".repeat(50) }
    expect(await open(await seal(obj, key), key)).toEqual(obj)
  })

  it("rejects the wrong key", async () => {
    const key = await deriveKey("pw", SALT, 10000)
    const wrong = await deriveKey("nope", SALT, 10000)
    await expect(open(await seal({ a: 1 }, key), wrong)).rejects.toBeDefined()
  })
})
