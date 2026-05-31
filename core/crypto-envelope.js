// Server-side AES-256-GCM payload envelope for the web build's optional E2E mode.
// Keeps content opaque to a TLS-intercepting proxy (Zscaler): even after it strips
// TLS, every /api body + SSE frame is `base64(iv ‖ ciphertext ‖ tag)` under a key
// derived from a passphrase the proxy never sees. CommonJS so web/server.mjs imports
// it. Wire-compatible with the browser WebCrypto twin (src/lib/crypto-envelope.ts).
// Tested by crypto-envelope.test.ts. See t012 / ADR-0006.
const crypto = require("node:crypto")

const IV_LEN = 12

/** PBKDF2-SHA256 → 32-byte AES key. `salt` is base64 (public, served to the client). */
function deriveKey(passphrase, saltB64, iterations) {
  return crypto.pbkdf2Sync(passphrase, Buffer.from(saltB64, "base64"), iterations, 32, "sha256")
}

function seal(obj, key) {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()])
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64")
}

function open(b64, key) {
  const buf = Buffer.from(b64, "base64")
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(IV_LEN, buf.length - 16)
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]) // throws on wrong key/tamper
  return JSON.parse(pt.toString("utf8"))
}

module.exports = { deriveKey, seal, open }
