// The chat BFF live-update WebSocket client (PSN-93, Workstream E). Connects to `/api/chat/ws`
// (same origin, wss? by page protocol), receives a snapshot on connect then deltas, and steers the
// server's fast-sweep by sending `{type:"focus",convId}` when the open thread changes.
//
// Reconnect rides the shared pure `reconnect-backoff` schedule (src/lib) — the same one the browser
// renderer's Remote Page uses — so the cadence is one tested curve. A drop schedules the next
// attempt; a successful open resets it. The connection state (`online` | `reconnecting`) is reported
// so the app can flip its "Reconnecting…" banner; a poll fallback (owned by the caller) covers a WS
// that never opens.
//
// Frames are the contract's `ChatWsServerMessage` tagged union (apps/chat-server/src/contract.ts).
// This module mirrors that union against the FE's `Teams*` shapes (field-identical minus the
// `service` tag) so the app applies them through the existing `message-merge`/`conversation-merge`
// reducers with no conversion.

import { type BackoffState, initialBackoff, nextBackoff } from "@/lib/reconnect-backoff"
import type { TeamsConversation, TeamsMessage } from "./teams-client"

/** A server→client frame. Mirrors ChatWsServerMessage with `Teams*` payload shapes. */
export type ChatWsFrame =
  | { type: "conversation-upsert"; conversations: TeamsConversation[] }
  | { type: "messages-upsert"; convId: string; messages: TeamsMessage[] }
  | { type: "read-state"; convId: string; readTs: number; unreadSticky: boolean }
  | { type: "backfill-progress"; status: unknown }
  | { type: "health"; ok: boolean; code?: string }
  /** Sync diagnostics pushed by the BFF sweep engine (Workstream D). */
  | {
      type: "sync-log"
      lastHealthOk: number | null
      lastError: number | null
      lastErrorCode?: string
      events: import("./sync-log").SyncEvent[]
    }
  /** Server liveness heartbeat (PSN-106) — consumed by the watchdog, never forwarded to the app. */
  | { type: "ping"; ts: number }

/** The connection state surfaced to the app: `online` when the socket is open + healthy, else
 *  `reconnecting` (drives the banner). A `giveUp` from the backoff schedule stays `reconnecting`
 *  and lets the caller's poll fallback carry reads. */
export type ChatWsStatus = "online" | "reconnecting"

export interface ChatWsClient {
  /** Steer the server fast-sweep: the currently open thread, or null when none is open. Re-sent on
   *  every (re)connect so a mid-drop focus survives. */
  setFocus(convId: string | null): void
  /** Tear the socket down and stop reconnecting. */
  close(): void
}

interface ChatWsDeps {
  /** Every parsed server frame. */
  onFrame(frame: ChatWsFrame): void
  /** online ⇄ reconnecting transitions (deduped — fires only on a real change). */
  onStatus(status: ChatWsStatus): void
  /** Injectable for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket
  /** Injectable timer for tests; defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
  /** Override the ws URL (tests). Defaults to the same-origin `/api/chat/ws`. */
  url?: string
}

// Same schedule shape as the renderer's Remote Page reconnect (t040): quick first retries, capped,
// but never "give up" for the chat surface — a long-backgrounded PWA must still recover on wake, so
// maxAttempts is large and the cap keeps the steady-state cadence sane.
const BACKOFF_CONFIG = { baseMs: 500, factor: 2, capMs: 15_000, maxAttempts: 1_000 }

/** Silence budget before an open socket is treated as dead (PSN-106). The server heartbeats every
 *  20s (ws-hub PING_MS), so two missed beats plus slack means only a genuinely broken path trips it.
 *  A half-open socket (sleep/wake, wifi change, LB dropping state) never fires `onclose`, so without
 *  this the client reports `online` forever and delivers nothing. */
export const WS_LIVENESS_TIMEOUT_MS = 45_000

/** The same-origin ws URL for the BFF hub. */
function defaultUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${window.location.host}/api/chat/ws`
}

/** Open a live chat WS with auto-reconnect + focus steering. Starts connecting immediately. */
export function createChatWs(deps: ChatWsDeps): ChatWsClient {
  const WsImpl = deps.WebSocketImpl ?? WebSocket
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  const now = deps.now ?? (() => Date.now())
  const url = deps.url ?? defaultUrl()

  let ws: WebSocket | null = null
  let backoff: BackoffState = initialBackoff()
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let liveTimer: ReturnType<typeof setTimeout> | null = null
  let lastFrameAt = 0
  let focus: string | null = null
  let status: ChatWsStatus = "reconnecting"
  let closed = false

  function setStatus(next: ChatWsStatus): void {
    if (status === next) return
    status = next
    deps.onStatus(next)
  }

  function sendFocus(): void {
    if (ws?.readyState === WsImpl.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "focus", convId: focus }))
      } catch {}
    }
  }

  function stopWatchdog(): void {
    if (liveTimer) clearTimer(liveTimer)
    liveTimer = null
  }

  // Re-arm for exactly the time left in the silence budget, so a socket that has just been fed waits
  // the full window and a starved one trips on the next tick. One timer at a time, no polling.
  function armWatchdog(): void {
    stopWatchdog()
    if (closed) return
    const idleMs = now() - lastFrameAt
    liveTimer = setTimer(checkLiveness, Math.max(WS_LIVENESS_TIMEOUT_MS - idleMs, 0))
  }

  function checkLiveness(): void {
    liveTimer = null
    if (closed) return
    const sock = ws
    if (!sock) return
    if (now() - lastFrameAt < WS_LIVENESS_TIMEOUT_MS) {
      armWatchdog()
      return
    }
    // Silent past the budget: the socket is half-open. Detach its handlers first — a half-open
    // close can fire `onclose` late (or never), and an undetached one would schedule a second
    // reconnect on top of this one — then drive the same backoff reconnect the drop path uses.
    ws = null
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
    try {
      sock.close()
    } catch {}
    setStatus("reconnecting")
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (closed) return
    const { state, step } = nextBackoff(backoff, "drop", BACKOFF_CONFIG)
    backoff = state
    if (retryTimer) clearTimer(retryTimer)
    retryTimer = setTimer(connect, Math.max(step.delayMs, BACKOFF_CONFIG.baseMs))
  }

  function connect(): void {
    if (closed) return
    setStatus("reconnecting")
    let sock: WebSocket
    try {
      sock = new WsImpl(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws = sock

    sock.onopen = () => {
      if (closed) {
        try {
          sock.close()
        } catch {}
        return
      }
      backoff = initialBackoff()
      lastFrameAt = now()
      armWatchdog()
      setStatus("online")
      sendFocus()
    }
    sock.onmessage = (e: MessageEvent) => {
      // Any frame at all proves the socket is live, parseable or not.
      lastFrameAt = now()
      let frame: ChatWsFrame | null = null
      try {
        frame = JSON.parse(String(e.data)) as ChatWsFrame
      } catch {
        return
      }
      if (!frame || typeof frame.type !== "string") return
      if (frame.type === "ping") return // liveness only — the app has nothing to do with it
      deps.onFrame(frame)
    }
    sock.onclose = () => {
      if (ws === sock) ws = null
      stopWatchdog()
      setStatus("reconnecting")
      scheduleReconnect()
    }
    sock.onerror = () => {
      // onclose follows an error and drives the reconnect; closing here avoids a lingering socket.
      try {
        sock.close()
      } catch {}
    }
  }

  connect()

  return {
    setFocus(convId: string | null): void {
      if (focus === convId) return
      focus = convId
      sendFocus()
    },
    close(): void {
      closed = true
      if (retryTimer) clearTimer(retryTimer)
      retryTimer = null
      stopWatchdog()
      const sock = ws
      ws = null
      if (sock) {
        sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
        try {
          sock.close()
        } catch {}
      }
    },
  }
}
