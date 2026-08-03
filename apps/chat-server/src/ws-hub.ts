// The chat WS hub (PSN-93, Workstream C). Mounts a `ws` WebSocketServer at /api/chat/ws on the same
// Node http server as Hono. On connect it sends a snapshot (store conversations + prefs for the
// default service); after that the sweep (WS-D) drives deltas through the module-level `broadcast`.
// Clients steer the fast-sweep by sending `{type:"focus",convId}` — `getFocusedConvIds()` is what the
// sweep reads.
//
// The pure parts (focus tracking, snapshot assembly, backpressure fan-out) live in `HubState` so they
// unit-test against a fake socket set. Heartbeat/reap reuse core/ws-backpressure.js predicates.

import type { IncomingMessage } from "node:http"
import { createRequire } from "node:module"
import type { Duplex } from "node:stream"
import type BetterSqlite3 from "better-sqlite3"
import { type WebSocket, WebSocketServer } from "ws"
import type { ChatService, ChatWsClientMessage, ChatWsServerMessage } from "./contract.ts"
import * as store from "./store.ts"

const require = createRequire(import.meta.url)
const { shouldSkipClient, isClientDead } = require("../../../core/ws-backpressure.js") as {
  shouldSkipClient: (buffered: number, cap: number) => boolean
  isClientDead: (lastSeenAt: number, now: number, deadlineMs: number) => boolean
}

type Db = BetterSqlite3.Database

// The service a fresh client's snapshot covers. "teams" in prod; CHAT_PROVIDER=mock flips it to
// "mock" so the hermetic e2e snapshot reads the same rows the mock routes wrote.
const DEFAULT_SERVICE = process.env.CHAT_PROVIDER === "mock" ? "mock" : "teams"
const BUFFER_CAP = 4 * 1024 * 1024 // drop a frame for a client backed up past this
const PING_MS = 20_000
const DEAD_MS = 60_000 // no pong within this → reap

/** The minimal socket surface the hub drives — real `ws` sockets and test fakes both satisfy it. */
export interface HubSocket {
  send(data: string): void
  terminate?(): void
  close?(): void
  bufferedAmount?: number
  focus?: string | null
  lastSeenAt?: number
}

/** Snapshot payload a freshly-connected client gets: the current store view for the default service. */
export function buildSnapshot(
  db: Db,
  service: ChatService = DEFAULT_SERVICE,
): ChatWsServerMessage[] {
  return [
    { type: "conversation-upsert", service, conversations: store.listConversations(db, service) },
  ]
}

/** Pure hub state over a socket set: focus tracking, snapshot send, broadcast fan-out with
 *  backpressure + liveness. No `ws` import — testable with fakes. */
export class HubState {
  readonly clients = new Set<HubSocket>()
  // Explicit field (not a `private` param property) so `node --experimental-strip-types` can run
  // this file unmodified — strip-only mode rejects TS parameter properties.
  private db: Db
  constructor(db: Db) {
    this.db = db
  }

  add(sock: HubSocket, now: number = Date.now()): void {
    sock.focus = null
    sock.lastSeenAt = now
    this.clients.add(sock)
    this.snapshot(sock)
  }

  remove(sock: HubSocket): void {
    this.clients.delete(sock)
  }

  snapshot(sock: HubSocket): void {
    for (const frame of buildSnapshot(this.db)) trySend(sock, frame)
  }

  /** A client message → act on it. Returns true when it was a frame this hub understands.
   *
   *  Two kinds today: `focus` (steers the sweep's fast lane) and `suggest-request` (ADR-0027 —
   *  relayed to the other clients so a connected producer can answer it). Anything else is ignored
   *  rather than rejected: an older or newer client must not be able to break the socket. */
  onMessage(sock: HubSocket, raw: string, now: number = Date.now()): boolean {
    sock.lastSeenAt = now
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return false
    }
    if (!msg || typeof msg !== "object") return false
    const type = (msg as { type?: string }).type
    if (type === "focus") {
      const convId = (msg as { convId?: string | null }).convId
      sock.focus = typeof convId === "string" ? convId : null
      return true
    }
    if (type === "suggest-request") {
      const { convId, regenerate } = msg as { convId?: unknown; regenerate?: unknown }
      if (typeof convId !== "string" || !convId) return false
      this.relay(sock, {
        type: "suggest-request",
        convId,
        regenerate: regenerate === true,
      })
      return true
    }
    return false
  }

  /**
   * Pass a client frame on to every OTHER client. Used for `suggest-request`: the producer that
   * answers it (the Hermes plugin) is itself a client of this hub, so the request only has to reach
   * the other end of the same socket set — no second transport (ADR-0027 decision 3).
   *
   * The sender is skipped: a browser asking for suggestions must not receive its own request back
   * and try to answer it. The answer arrives separately as a `reply-suggestions` broadcast once a
   * producer writes the batch, which is why request and response carry no correlation id — the
   * batch is conversation state, not a reply addressed to one caller.
   */
  relay(from: HubSocket, msg: ChatWsClientMessage): void {
    for (const sock of this.clients) {
      if (sock === from) continue
      if (shouldSkipClient(sock.bufferedAmount ?? 0, BUFFER_CAP)) continue
      trySend(sock, msg)
    }
  }

  /** The distinct set of conversation ids clients are focused on — the sweep's fast-lane input. */
  getFocusedConvIds(): string[] {
    const out = new Set<string>()
    for (const s of this.clients) if (s.focus) out.add(s.focus)
    return [...out]
  }

  /** Fan a server frame to every live client, skipping over-buffered ones (fresh-frame-wins). */
  broadcast(msg: ChatWsServerMessage): void {
    for (const sock of this.clients) {
      if (shouldSkipClient(sock.bufferedAmount ?? 0, BUFFER_CAP)) continue
      trySend(sock, msg)
    }
  }

  /** Reap any client that hasn't ponged within DEAD_MS. Returns the reaped sockets. */
  reap(now: number = Date.now()): HubSocket[] {
    const dead: HubSocket[] = []
    for (const sock of this.clients) {
      if (isClientDead(sock.lastSeenAt ?? 0, now, DEAD_MS)) dead.push(sock)
    }
    for (const sock of dead) {
      this.clients.delete(sock)
      sock.terminate?.()
    }
    return dead
  }
}

/** Relayed client frames go out on the same socket as server frames (see `relay`), so the union
 *  covers both directions. */
function trySend(sock: HubSocket, msg: ChatWsServerMessage | ChatWsClientMessage): void {
  try {
    sock.send(JSON.stringify(msg))
  } catch {}
}

// ---- module singleton + ws wiring ----------------------------------------

let hub: HubState | null = null

/** Broadcast a delta to every connected chat client. Import target for the WS-D sweep. No-op until
 *  the hub is attached (server not yet booted). */
export function broadcast(msg: ChatWsServerMessage): void {
  hub?.broadcast(msg)
}

/** The conversation ids clients are focused on — drives the sweep's fast lane (WS-D). */
export function getFocusedConvIds(): string[] {
  return hub?.getFocusedConvIds() ?? []
}

/** Mount the hub on an existing http.Server. Returns the HubState (also stashed as the module
 *  singleton so `broadcast`/`getFocusedConvIds` work). The caller owns the http server + Hono; the
 *  hub only claims the /api/chat/ws upgrade path. */
export function attachWsHub(
  server: import("node:http").Server,
  db: Db,
  path = "/api/chat/ws",
): HubState {
  const state = new HubState(db)
  hub = state
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== path) return // let other upgrade handlers / default answer it
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // The ws socket already exposes `bufferedAmount` + `send` + `terminate`, so it satisfies
      // HubSocket directly — no shim. `focus`/`lastSeenAt` are stamped by `state.add`.
      const sock = ws as unknown as HubSocket
      state.add(sock)
      ws.on("pong", () => {
        sock.lastSeenAt = Date.now()
      })
      ws.on("message", (raw: Buffer) => state.onMessage(sock, raw.toString()))
      ws.on("close", () => state.remove(sock))
      ws.on("error", () => state.remove(sock))
    })
  })

  const timer = setInterval(() => {
    for (const sock of state.clients) {
      const ws = sock as unknown as WebSocket
      try {
        ws.ping()
      } catch {}
      // Also send an application-level heartbeat: a browser client never sees the protocol pong, so
      // this frame is the only thing that lets it distinguish a live socket from a half-open one
      // (PSN-106). Rides the same cadence as the ping.
      trySend(sock, { type: "ping", ts: Date.now() })
    }
    state.reap()
  }, PING_MS)
  timer.unref?.()

  return state
}
