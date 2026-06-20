/**
 * Web build — the optional WebSocket channel, lifted out of `cdp-web-transport.ts` for an
 * isolated test surface (t096, A5).
 *
 * Optional WebSocket channel (t019). When connected and ready, all CDP traffic — events
 * in, invokes/sends/batches out — rides one full-duplex socket instead of SSE+POST.
 * The picker in settings selects between Auto/Fastest(WS)/Streaming/Basic; this channel
 * is the "Fastest" path and the head of the Auto fallback chain. Returns a thin handle
 * the rest of createWebCdp consults via `ws.ready()` before falling back.
 */

import type { Cmd, WebTransportDeps } from "./cdp-web-transport"
import type { CryptoContext } from "./crypto-context"
import { notePing, notePong, resetLatencyMetrics } from "./latency-metrics"
import { perfMark } from "./perf-mark"

export function createWsChannel(
  deps: WebTransportDeps,
  crypto: CryptoContext,
  opts: {
    onEvent: (event: string, data: string) => void
    /** Fast path for screencast: a text "cdp-frame" envelope pairs with a binary WS frame
     *  carrying raw JPEG bytes. Skips base64 + the JSON.parse of a 250KB envelope on the
     *  renderer main thread. The caller forges a CDP event with `dataBlob` populated and
     *  dispatches through the normal CDP event listeners. */
    onFrameBinary?: (cdpMsg: {
      method: string
      params: Record<string, unknown> & { dataBlob: Blob }
    }) => void
    onReady: () => void
    onClose: () => void
  },
) {
  let socket: WebSocket | null = null
  let ready = false
  // Pending awaited invokes keyed by id; the server echoes the id in invoke-result.
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  // True when the outer asked us to close — suppresses the onClose callback so a stale
  // socket's late `close` event doesn't clobber a newly-opened channel's outer state.
  let suppressClose = false

  // Keepalive + RTT probe (t057). While the socket is ready, a plaintext `ping` carrying a
  // client-monotonic stamp fires on a fixed interval regardless of input/frame traffic, so
  // an idle WS isn't reaped by an upstream proxy (nginx default idle ~60s). The server pongs
  // it straight back; the onmessage handler folds the round-trip into the RTT estimator. The
  // ping is control traffic — never sealed, never routed through the dispatcher's CDP path.
  const PING_INTERVAL_MS = 20000
  let pingSeq = 0
  let pingTimer: ReturnType<typeof setInterval> | null = null
  function sendPing() {
    if (!socket || socket.readyState !== deps.WebSocket.OPEN) return
    const seq = ++pingSeq
    const sentAt = performance.now()
    notePing(seq, sentAt)
    try {
      // `ts` carries the client's monotonic stamp; the server echoes it unchanged. RTT is
      // measured against the local `outstanding` map keyed by `seq`, never the echoed `ts`.
      socket.send(JSON.stringify({ t: "ping", seq, ts: sentAt }))
    } catch {}
  }
  function startPingPump() {
    if (pingTimer !== null) return
    sendPing() // probe immediately so RTT lands without waiting a full interval
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS)
  }

  // Ack-after-paint control (t056) — plaintext like ping (no user content), so it's E2E-
  // agnostic and skips the seal round-trip. `frame-ack-mode` opts this client into the
  // server's one-in-flight gate; `frame-ack` is the post-paint ack the viewport fires,
  // releasing the slot so the server acks the remote and the next frame flows.
  function sendControl(payload: unknown) {
    if (!socket || socket.readyState !== deps.WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(payload))
    } catch {}
  }
  function stopPingPump() {
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    // The estimator degrades cleanly when WS is gone — report unavailable, not a stale RTT.
    resetLatencyMetrics()
  }

  function open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${proto}//${location.host}/api/ws`
    try {
      socket = new deps.WebSocket(url)
    } catch {
      opts.onClose()
      return
    }
    // The binary frame fast path: server sends a text "cdp-frame" envelope first
    // (containing metadata + sessionId) then the raw JPEG bytes as the next WS message.
    // Delivering as Blob is faster than ArrayBuffer for createImageBitmap — no extra copy.
    socket.binaryType = "blob"
    let pendingFrame: { method: string; params: Record<string, unknown> } | null = null
    socket.onmessage = async (ev) => {
      // Binary message → pair with the preceding "cdp-frame" envelope.
      if (ev.data instanceof Blob) {
        if (!pendingFrame) return // out-of-order binary, drop
        const frame = pendingFrame
        pendingFrame = null
        opts.onFrameBinary?.({
          method: frame.method,
          params: { ...frame.params, dataBlob: ev.data },
        })
        return
      }
      // Envelope is always plaintext JSON (the `t` field is routing metadata, like SSE
      // event names). For event messages, `data` is the sealed CDP payload that onSse()
      // unwraps. For invoke-result, the server passes the CDP invoke output through plain
      // — these are server-generated, not user content.
      const tEntry = performance.now() // [DEBUG-perf]
      const text = ev.data as string
      const tParse = performance.now() // [DEBUG-perf]
      let msg: {
        t: string
        event?: string
        data?: unknown
        id?: number
        result?: unknown
        seq?: number
      }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      // [DEBUG-perf] Only mark big-payload events (the cdp screencast frames) so we measure
      // the actual bottleneck and not all the tiny notification envelopes.
      if (msg.t === "event" && msg.event === "cdp" && text.length > 5000) {
        perfMark("wsRecv", tParse - tEntry)
        perfMark("jsonParse", performance.now() - tParse)
      }
      if (msg.t === "ready") {
        ready = true
        startPingPump()
        sendControl({ t: "frame-ack-mode" }) // opt into the server's one-in-flight gate (t056)
        opts.onReady()
      } else if (msg.t === "pong") {
        // Control traffic — never fanned out as a CDP event. Fold the round-trip into the
        // always-on RTT/jitter estimator against the client clock (t057).
        if (typeof msg.seq === "number") notePong(msg.seq, performance.now())
      } else if (msg.t === "event" && msg.event === "cdp-frame") {
        // Stash metadata; the next binary message is the JPEG bytes for this frame.
        pendingFrame = msg.data as { method: string; params: Record<string, unknown> }
      } else if (msg.t === "event" && msg.event && msg.data !== undefined) {
        opts.onEvent(msg.event, msg.data as string)
      } else if (msg.t === "invoke-result" && typeof msg.id === "number") {
        const cb = pending.get(msg.id)
        pending.delete(msg.id)
        // Result is sealed under E2E (the routing envelope around it stays plaintext); the
        // open is the CryptoContext's, the one downlink ingress for an invoke reply.
        const result =
          crypto.mode === "e2e" ? await crypto.openText(msg.result as string) : msg.result
        cb?.(result)
      }
    }
    socket.onclose = () => {
      ready = false
      socket = null
      stopPingPump()
      for (const cb of pending.values()) cb({ error: "ws closed" })
      pending.clear()
      if (suppressClose) return // caller already handled the outer state on explicit close
      opts.onClose()
    }
    socket.onerror = () => {
      try {
        socket?.close()
      } catch {}
    }
  }

  async function rawSend(payload: unknown) {
    if (!socket || socket.readyState !== deps.WebSocket.OPEN) return false
    // One seal at the WS uplink egress — the whole `{ t, … }` envelope is sealed (the server
    // opens it as one body), via the CryptoContext, not an inline key read.
    const text = await crypto.sealText(payload)
    try {
      socket.send(text)
      return true
    } catch {
      return false
    }
  }

  open()

  return {
    isReady: () => ready,
    close: () => {
      suppressClose = true
      socket?.close()
    },
    send: (method: string, params?: unknown) => rawSend({ t: "send", method, params }),
    paintAck: (sessionId: number) => sendControl({ t: "frame-ack", sessionId }),
    batch: (items: Cmd[]) => rawSend({ t: "batch", items }),
    invoke: (method: string, params?: unknown) =>
      new Promise<unknown>((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        void rawSend({ t: "invoke", id, method, params }).then((ok) => {
          if (!ok) {
            pending.delete(id)
            resolve({ error: "ws send failed" })
          }
        })
      }),
  }
}
