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
  /** Override the ws URL (tests). Defaults to the same-origin `/api/chat/ws`. */
  url?: string
}

// Same schedule shape as the renderer's Remote Page reconnect (t040): quick first retries, capped,
// but never "give up" for the chat surface — a long-backgrounded PWA must still recover on wake, so
// maxAttempts is large and the cap keeps the steady-state cadence sane.
const BACKOFF_CONFIG = { baseMs: 500, factor: 2, capMs: 15_000, maxAttempts: 1_000 }

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
  const url = deps.url ?? defaultUrl()

  let ws: WebSocket | null = null
  let backoff: BackoffState = initialBackoff()
  let retryTimer: ReturnType<typeof setTimeout> | null = null
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
      setStatus("online")
      sendFocus()
    }
    sock.onmessage = (e: MessageEvent) => {
      let frame: ChatWsFrame | null = null
      try {
        frame = JSON.parse(String(e.data)) as ChatWsFrame
      } catch {
        return
      }
      if (frame && typeof frame.type === "string") deps.onFrame(frame)
    }
    sock.onclose = () => {
      if (ws === sock) ws = null
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
