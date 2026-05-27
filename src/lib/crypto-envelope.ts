/**
 * Browser AES-256-GCM payload envelope for the web build's optional E2E mode — the
 * WebCrypto twin of the server's `crypto-envelope.js`, wire-compatible with it
 * (`base64(iv ‖ ciphertext ‖ tag)`, PBKDF2-SHA256 key). Keeps content opaque to a
 * TLS-intercepting proxy: the passphrase/key never leave the browser. The derived key
 * is non-extractable. See t012 / ADR-0006.
 */

const IV_LEN = 12
const subtle = () => globalThis.crypto.subtle

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** PBKDF2-SHA256 → non-extractable AES-256-GCM key. `saltB64` comes from /api/crypto-params. */
export async function deriveKey(
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<CryptoKey> {
  const base = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  )
  return subtle().deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(saltB64) as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

export async function seal(obj: unknown, key: CryptoKey): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN))
  const pt = new TextEncoder().encode(JSON.stringify(obj))
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, pt as BufferSource),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv)
  out.set(ct, iv.length)
  return bytesToB64(out)
}

export async function open(b64: string, key: CryptoKey): Promise<unknown> {
  const buf = b64ToBytes(b64)
  const iv = buf.subarray(0, IV_LEN)
  const ct = buf.subarray(IV_LEN)
  // rejects on wrong key/tamper
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  )
  return JSON.parse(new TextDecoder().decode(pt))
}
