/**
 * The web build's client→server command path, split into an explicit **Uplink** seam.
 *
 * Before this seam the choice of where a command goes — `wsReady ? ws.batch : streamReady
 * ? stream : cdp-batch POST` — was inlined and duplicated across both branches of the input
 * batcher and again in the raw `send`/`invoke` paths. Adding or reordering a transport meant
 * editing every call site. The router consolidates that decision into one place: every
 * command flows `caller → router.pick() → uplink.<method>()`.
 *
 * Pure (lib-style): the router holds no socket and opens no fetch. It owns *which* ready
 * adapter carries a command, given the set of adapters and the advised mode. The three
 * adapters (WS / stream / POST) are thin effect wrappers that live with the transport
 * effects in `cdp-web-transport.ts` — they hold the sockets/fetch. `transport-selector.ts`
 * stays the pure, shallow advisor: it computes mode intent, the router consumes that advice
 * and delegates. Readiness belongs to the adapters; mode advice belongs to the selector.
 *
 * See docs/tasks/022 and ADR-0007.
 */

/** The concrete adapter a command can be routed to — derived from `InputTransportMode`. */
export type AdvisedMode = "ws" | "stream" | "batch"

/** A single CDP command on the uplink. */
export interface UplinkCommand {
  method: string
  params?: unknown
}

/** The seam every outbound command crosses. WS / stream / POST each implement it. */
export interface Uplink {
  isReady(): boolean
  send(cmd: UplinkCommand): void
  sendBatch(cmds: UplinkCommand[]): void
  invoke(method: string, params?: unknown): Promise<unknown>
  close(): void
}

export interface UplinkRouterDeps {
  /** The full set of adapters the router owns and tears down. */
  adapters: Record<AdvisedMode, Uplink>
  /** The selector's advice: which adapter to prefer right now. Re-read on every pick so a
   *  mode change (Auto/WS/Stream/Basic) re-points the router with no extra wiring. */
  advise: () => AdvisedMode
}

/** The router exposes the same surface as a single `Uplink`, plus `pick()` for tests/debug. */
export interface UplinkRouter extends Uplink {
  /** The adapter a command would route to right now (advised mode, falling through). */
  pick(): Uplink
}

// The not-ready fall-through order. The advised mode is tried first, then the chain in this
// fixed order so a command is never dropped — matches the prior inlined behavior
// (`wsReady ? … : streamReady ? … : POST`), with the POST/batch adapter as the floor.
const FALLBACK_ORDER: AdvisedMode[] = ["ws", "stream", "batch"]

export function createUplinkRouter({ adapters, advise }: UplinkRouterDeps): UplinkRouter {
  function pick(): Uplink {
    const advised = adapters[advise()]
    if (advised.isReady()) return advised
    for (const mode of FALLBACK_ORDER) {
      const adapter = adapters[mode]
      if (adapter !== advised && adapter.isReady()) return adapter
    }
    // No adapter is ready — return the advised one anyway so the command is delegated, not
    // dropped (the adapter itself decides what to do with a not-ready send; today that means
    // the batch/POST adapter, which is the floor and effectively always ready).
    return advised
  }

  return {
    pick,
    isReady: () => Object.values(adapters).some((a) => a.isReady()),
    send: (cmd) => pick().send(cmd),
    sendBatch: (cmds) => pick().sendBatch(cmds),
    invoke: (method, params) => pick().invoke(method, params),
    close: () => {
      for (const adapter of Object.values(adapters)) adapter.close()
    },
  }
}
