/**
 * The web build's server→client half of the Transport seam, split into two pieces:
 *
 * - `Downlink` — a shallow source-abstraction (`{ onEvent, onClose, close }`). Exactly one
 *   is ever live, backed by WS or SSE (never both). Switching sources tears the prior one
 *   down fully; a stale source's late events / close never leak through after `close()`.
 * - `Dispatcher` — the deep module: a decoded inbound message is fanned out to every
 *   registered listener of its kind, and the OS/web toast fires exactly once per
 *   Notification. No path bypasses it — the SSE `cdp` listener, the WS `onEvent` path, and
 *   the WS binary-frame path all route here, so the decode/filter/fan-out/toast logic lives
 *   in one place instead of being re-implemented per source.
 *
 * Pure (lib-style): the dispatcher owns fan-out + toast-once gating only. The effectful
 * wiring — WS/SSE attach, E2E decode, the actual OS/web toast effect — stays in the caller
 * (`cdp-web-transport.ts`), which injects the toast and decodes each payload before
 * calling `dispatch`. See docs/tasks/021.
 */

/** A decoded server push, already E2E-opened by the caller, ready to fan out. */
export type DownlinkKind = "cdp" | "disconnected" | "notification" | "notification-activate"

export interface DispatcherDeps<N = unknown> {
  /** Fire the OS/web toast for a Notification — invoked once per `notification` dispatch.
   *  The caller gates it (visibility / permission / opt-in); the dispatcher only guarantees
   *  it is called at most once per notification, after the notification listeners. */
  toast: (entry: N) => void
  /** Record a Screencast Frame's server send timestamp for always-on frame-age metrics
   *  (t057) — handed in before fan-out, on the `cdp` route only when the payload is a
   *  `Page.screencastFrame` carrying `serverTs`. The effectful `now`/snapshot read lives in
   *  the recorder; the dispatcher just forwards the server stamp. Optional: tests and the
   *  Electron path (no web timestamp) omit it. */
  recordFrameAge?: (serverTs: number) => void
}

/** Pull a frame's server send timestamp off a `cdp` payload, if it is a screencast frame
 *  that carries one. Non-frame events and timestamp-less frames (SSE without the field)
 *  return undefined so frame age reports unavailable rather than fabricating one. */
function frameServerTs(payload: unknown): number | undefined {
  const params =
    (payload as { method?: string; params?: { serverTs?: unknown } } | null)?.method ===
    "Page.screencastFrame"
      ? (payload as { params?: { serverTs?: unknown } }).params
      : undefined
  return typeof params?.serverTs === "number" ? params.serverTs : undefined
}

/** Phase carried by a `disconnected` dispatch — web auto-reconnect (t040) reports
 *  "reconnecting" while the backoff loop retries and "lost" once it gives up. Absent ⇒
 *  a plain terminal loss (the pre-t040 meaning). */
export type DisconnectPhase = "reconnecting" | "lost"

export interface Dispatcher<N = unknown> {
  onEvent(cb: (msg: unknown) => void): () => void
  onDisconnected(cb: (phase?: DisconnectPhase) => void): () => void
  onNotification(cb: (entry: N) => void): () => void
  onNotificationActivate(cb: (entry: N) => void): () => void
  /** Fan a decoded payload out to its kind's listeners; `notification` also fires the toast. */
  dispatch(kind: DownlinkKind, payload: unknown): void
}

function register<T>(list: T[], cb: T): () => void {
  list.push(cb)
  return () => {
    const i = list.indexOf(cb)
    if (i !== -1) list.splice(i, 1)
  }
}

// Fan out to every listener even if one throws (t099): an unguarded loop would stop at the
// first throw AND propagate up to the source's message handler, poisoning the whole downlink
// (frozen session until reload). Each listener is isolated; a throw is logged, never fatal.
function fanOut<T>(list: ((arg: T) => void)[], arg: T): void {
  for (const cb of list) {
    try {
      cb(arg)
    } catch (e) {
      console.error("[downlink] listener threw (isolated):", e)
    }
  }
}

export function createDownlinkDispatcher<N = unknown>(deps: DispatcherDeps<N>): Dispatcher<N> {
  const listeners = {
    event: [] as ((msg: unknown) => void)[],
    disconnected: [] as ((phase?: DisconnectPhase) => void)[],
    notification: [] as ((entry: N) => void)[],
    notificationActivate: [] as ((entry: N) => void)[],
  }
  return {
    onEvent: (cb) => register(listeners.event, cb),
    onDisconnected: (cb) => register(listeners.disconnected, cb),
    onNotification: (cb) => register(listeners.notification, cb),
    onNotificationActivate: (cb) => register(listeners.notificationActivate, cb),
    dispatch(kind, payload) {
      switch (kind) {
        case "cdp": {
          // Record frame age before fan-out (t057) — only a screencast frame with a server
          // stamp; everything else is a no-op. Never alters the payload handed to listeners.
          const serverTs = frameServerTs(payload)
          if (serverTs !== undefined) deps.recordFrameAge?.(serverTs)
          fanOut(listeners.event, payload)
          return
        }
        case "disconnected":
          fanOut(listeners.disconnected, payload as DisconnectPhase | undefined)
          return
        case "notification": {
          const entry = payload as N
          fanOut(listeners.notification, entry)
          try {
            deps.toast(entry)
          } catch (e) {
            // A page-context `new Notification()` throws on iOS/Android — must not poison the
            // downlink (t099). The toast is best-effort; the entry already reached listeners.
            console.error("[downlink] toast threw (isolated):", e)
          }
          return
        }
        case "notification-activate":
          fanOut(listeners.notificationActivate, payload as N)
          return
      }
    },
  }
}

/** The handlers a `Downlink` wires its source up to. */
export interface DownlinkSourceHandlers {
  /** A decoded server push from the source — `event` is the kind, `data` the payload. */
  onEvent(event: string, data: unknown): void
  /** The source dropped (WS close, SSE error) — `reason` is informational. */
  onClose(reason: string): void
}

/** The one live source behind a Downlink — WS-backed or SSE-backed. `attach` wires the
 *  source up to the Downlink's handlers; `detach` fully tears it down so no stale push
 *  leaks through after the Downlink closes. */
export interface DownlinkSource {
  attach(handlers: DownlinkSourceHandlers): void
  detach(): void
}

/** What the Downlink hands its decoded events to. Kept minimal so a fake dispatcher drives
 *  the seam in tests without the full dispatcher surface. */
interface DispatchSink {
  dispatch(kind: string, payload: unknown): void
}

export interface Downlink {
  onClose(cb: (reason: string) => void): () => void
  close(): void
}

/**
 * Build the single live Downlink over a source. Source events route straight to the
 * dispatcher (caller pre-decodes E2E); a source close — or an explicit `close()` — fires
 * the registered onClose listeners. After `close()`, the source is detached and any late
 * push or late close from it is ignored, so only one source is ever effectively live.
 */
export function createDownlink(dispatcher: DispatchSink, source: DownlinkSource): Downlink {
  const closeListeners: ((reason: string) => void)[] = []
  let closed = false
  function fireClose(reason: string) {
    if (closed) return
    closed = true
    source.detach()
    for (const cb of closeListeners) cb(reason)
  }
  source.attach({
    onEvent: (event, data) => {
      if (closed) return
      dispatcher.dispatch(event, data)
    },
    onClose: (reason) => fireClose(reason),
  })
  return {
    onClose: (cb) => register(closeListeners, cb),
    close: () => fireClose("closed"),
  }
}
