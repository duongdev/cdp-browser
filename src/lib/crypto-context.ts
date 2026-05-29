/**
 * The single owner of the web build's E2E envelope. Before this, the seal/open was smeared
 * across every per-call helper (`getJson`/`postJson`/`postRaw`/`rawSend`/`onSse`), each
 * reading the live key and branching `if (key) envSeal(...) else JSON.stringify(...)`.
 * `CryptoContext` folds that into one object: the uplink-router seals every client→server
 * body through it once before the body leaves, the downlink dispatcher opens every
 * server→client payload through it once on the way in, and the REST bridge serializes its
 * bodies through it too — so adding or reordering a transport never re-touches crypto.
 *
 * Pure (lib-style): it wraps the byte-identical `crypto-envelope.ts` seal/open and holds no
 * socket, no fetch, no DOM. The wire stays identical to the pre-fold baseline — plaintext is
 * `JSON.stringify`, sealed is `base64(iv ‖ ct ‖ tag)` — only the call site moves.
 *
 * Handshake gate: the e2e context starts `ready` (today the passphrase handshake runs in
 * `bootstrapE2E` before `createWebCdp` is built, so the key is always confirmed by then),
 * but the seams consult `ready` so a future deferred handshake can refuse to send/dispatch
 * until `confirm()` flips it. See docs/tasks/023, ADR-0006, ADR-0007.
 */

import { open as envOpen, seal as envSeal } from "./crypto-envelope"

export interface CryptoContext {
  /** `off` ⇒ plaintext JSON; `e2e` ⇒ AES-256-GCM sealed. */
  readonly mode: "off" | "e2e"
  /** The handshake gate. Seams refuse to send/dispatch until this is true. */
  readonly ready: boolean
  /** The Content-Type a sealed/plaintext body posts as — mirrors the server's choice. */
  readonly contentType: "application/json" | "text/plain"
  /** Serialize an object to its wire form (sealed text under e2e, JSON otherwise). */
  sealText(obj: unknown): Promise<string>
  /** Parse a wire payload back to its object (opens the envelope under e2e). */
  openText(text: string): Promise<unknown>
  /** Confirm the handshake — flips `ready` true. No-op in `off` mode. */
  confirm(): void
}

export type CryptoContextInit = { mode: "off" } | { mode: "e2e"; key: CryptoKey; ready?: boolean }

export function createCryptoContext(init: CryptoContextInit): CryptoContext {
  if (init.mode === "off") {
    return {
      mode: "off",
      ready: true,
      contentType: "application/json",
      sealText: (obj) => Promise.resolve(JSON.stringify(obj)),
      openText: (text) => Promise.resolve(JSON.parse(text)),
      confirm: () => {},
    }
  }
  const { key } = init
  let ready = init.ready ?? true
  return {
    mode: "e2e",
    get ready() {
      return ready
    },
    contentType: "text/plain",
    sealText: (obj) => envSeal(obj, key),
    openText: (text) => envOpen(text, key),
    confirm: () => {
      ready = true
    },
  }
}
