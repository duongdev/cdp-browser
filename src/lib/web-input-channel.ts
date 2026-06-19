/**
 * Web build — the low-latency streaming input channel, lifted out of `cdp-web-transport.ts`
 * for an isolated test surface (t096, A5).
 *
 * The low-latency input path: one long-lived POST whose body streams NDJSON frames,
 * so input flushes don't each pay a fresh request's TLS/auth/RTT through the proxy
 * chain. Pairs with the SSE down-channel — no WebSocket. See t011.
 *
 * Safety: a buffering proxy (Authentik/openresty without `proxy_request_buffering off`)
 * would accept the stream but never deliver the body — input would vanish. So on open we
 * send a `probe` frame and only switch real input onto the stream once the server echoes
 * a `stream-ack` over SSE. Until confirmed (and forever, if the probe is never acked) we
 * use a per-flush POST. `notifyAck()` is called by the SSE `stream-ack` handler.
 */

import type { Cmd, WebTransportDeps } from "./cdp-web-transport"
import type { Batch } from "./input-coalesce"

// Chrome/Edge can stream a request body (ReadableStream + duplex:'half') over HTTP/2.
// Detection per the documented pattern: duplex is read and no Content-Type is auto-set.
export const SUPPORTS_REQUEST_STREAMING = (() => {
  if (typeof ReadableStream === "undefined" || typeof Request === "undefined") return false
  try {
    let duplexAccessed = false
    const hasContentType = new Request("http://x", {
      body: new ReadableStream(),
      method: "POST",
      get duplex() {
        duplexAccessed = true
        return "half"
      },
      // biome-ignore lint/suspicious/noExplicitAny: duplex not yet in lib.dom RequestInit
    } as any).headers.has("Content-Type")
    return duplexAccessed && !hasContentType
  } catch {
    return false
  }
})()

export function createInputChannel(
  deps: WebTransportDeps,
  postFallback: (batch: Batch<Cmd>) => void,
) {
  const enc = new TextEncoder()
  // Give up after this many establish attempts that never get acked (no HTTP/2, or a
  // buffering proxy) and stay on the POST fallback for good — don't loop forever.
  const MAX_ATTEMPTS = 2
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let abort: AbortController | null = null
  let state: "idle" | "probing" | "streaming" | "blocked" = "idle"
  let attempts = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function onSettle() {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    controller = null
    if (state === "blocked") return
    const wasStreaming = state === "streaming" // dropped after working ⇒ transient
    state = "idle"
    if (wasStreaming) attempts = 0
    else if (attempts >= MAX_ATTEMPTS) {
      state = "blocked"
      return
    }
    setTimeout(open, 1000)
  }

  function open() {
    if (!SUPPORTS_REQUEST_STREAMING || state !== "idle") return
    state = "probing"
    attempts++
    abort = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        c.enqueue(enc.encode(`${JSON.stringify({ probe: 1 })}\n`))
      },
    })
    // Resolves only when the body closes (half-duplex) — we never close it, so settling
    // means the channel dropped. Replies (incl. the probe ack) arrive over SSE.
    deps
      .fetch("/api/input-stream", {
        method: "POST",
        body,
        signal: abort.signal,
        duplex: "half",
        // biome-ignore lint/suspicious/noExplicitAny: duplex not yet in lib.dom RequestInit
      } as any)
      .catch(() => {})
      .finally(onSettle)
    // No ack in the window ⇒ a buffering proxy swallowed the body (fetch hangs) ⇒ abort
    // so onSettle counts the failed attempt and eventually falls back permanently.
    watchdog = setTimeout(() => {
      if (state === "probing") abort?.abort()
    }, 3000)
  }
  open()

  return {
    send(batch: Batch<Cmd>) {
      if (state === "streaming" && controller) {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(batch)}\n`))
          return
        } catch {
          state = "idle"
        }
      }
      postFallback(batch)
    },
    notifyAck() {
      if (state === "probing") {
        if (watchdog) {
          clearTimeout(watchdog)
          watchdog = null
        }
        attempts = 0
        state = "streaming"
      }
    },
  }
}
