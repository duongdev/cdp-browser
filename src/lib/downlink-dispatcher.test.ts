import { describe, expect, it, vi } from "vitest"
import {
  createDownlink,
  createDownlinkDispatcher,
  type DownlinkSource,
} from "./downlink-dispatcher"

// --- dispatcher: fan-out + toast-once --------------------------------------------------

describe("createDownlinkDispatcher", () => {
  it("fans a decoded cdp event out to every event listener once, in registration order", () => {
    const d = createDownlinkDispatcher({ toast: () => {} })
    const seen: string[] = []
    d.onEvent(() => seen.push("a"))
    d.onEvent(() => seen.push("b"))
    const msg = { method: "Page.loadEventFired", params: {} }
    d.dispatch("cdp", msg)
    expect(seen).toEqual(["a", "b"])
  })

  it("dispatches the cdp payload object itself to event listeners", () => {
    const d = createDownlinkDispatcher({ toast: () => {} })
    const got: unknown[] = []
    d.onEvent((m) => got.push(m))
    const frame = { method: "Page.screencastFrame", params: { data: "jpeg" } }
    d.dispatch("cdp", frame)
    expect(got).toEqual([frame])
  })

  it("fans disconnected out to every disconnected listener once, in order", () => {
    const d = createDownlinkDispatcher({ toast: () => {} })
    const seen: string[] = []
    d.onDisconnected(() => seen.push("a"))
    d.onDisconnected(() => seen.push("b"))
    d.dispatch("disconnected", undefined)
    expect(seen).toEqual(["a", "b"])
  })

  it("fans notification out to every notification listener and fires the toast once", () => {
    const toast = vi.fn()
    const d = createDownlinkDispatcher({ toast })
    const seen: string[] = []
    d.onNotification(() => seen.push("a"))
    d.onNotification(() => seen.push("b"))
    const entry = { id: "n1", title: "hi" }
    d.dispatch("notification", entry)
    expect(seen).toEqual(["a", "b"])
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(entry)
  })

  it("does not double-fire the toast across multiple notification listeners", () => {
    const toast = vi.fn()
    const d = createDownlinkDispatcher({ toast })
    d.onNotification(() => {})
    d.onNotification(() => {})
    d.onNotification(() => {})
    d.dispatch("notification", { id: "n1" })
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it("fans notification-activate out to every activate listener and fires no toast", () => {
    const toast = vi.fn()
    const d = createDownlinkDispatcher({ toast })
    const seen: string[] = []
    d.onNotificationActivate(() => seen.push("a"))
    d.onNotificationActivate(() => seen.push("b"))
    d.dispatch("notification-activate", { id: "n1" })
    expect(seen).toEqual(["a", "b"])
    expect(toast).not.toHaveBeenCalled()
  })

  it("a kind with no registered listeners produces no calls and no toast", () => {
    const toast = vi.fn()
    const d = createDownlinkDispatcher({ toast })
    // No listeners registered for any kind.
    d.dispatch("cdp", { method: "X" })
    d.dispatch("disconnected", undefined)
    expect(toast).not.toHaveBeenCalled()
  })

  it("a screencast frame from a WS-binary source and an SSE source dispatch identically", () => {
    const d = createDownlinkDispatcher({ toast: () => {} })
    const got: unknown[] = []
    d.onEvent((m) => got.push(m))
    // SSE source: a JSON-decoded Page.screencastFrame event.
    const sseFrame = { method: "Page.screencastFrame", params: { data: "jpeg" } }
    d.dispatch("cdp", sseFrame)
    // WS-binary source: a forged Page.screencastFrame carrying a Blob — same kind, same path.
    const wsFrame = { method: "Page.screencastFrame", params: { dataBlob: "blob" } }
    d.dispatch("cdp", wsFrame)
    expect(got).toEqual([sseFrame, wsFrame])
  })

  it("unsubscribe removes only that listener", () => {
    const d = createDownlinkDispatcher({ toast: () => {} })
    const seen: string[] = []
    const off = d.onEvent(() => seen.push("a"))
    d.onEvent(() => seen.push("b"))
    off()
    d.dispatch("cdp", { method: "X" })
    expect(seen).toEqual(["b"])
  })

  it("isolates a throwing event listener so the others still receive (t099)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = createDownlinkDispatcher({ toast: () => {} })
    const seen: string[] = []
    d.onEvent(() => {
      throw new Error("boom")
    })
    d.onEvent(() => seen.push("b"))

    expect(() => d.dispatch("cdp", { method: "X" })).not.toThrow()
    expect(seen).toEqual(["b"])
    err.mockRestore()
  })

  it("isolates a throwing toast so the notification still reaches listeners (t099)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const seen: unknown[] = []
    const d = createDownlinkDispatcher({
      toast: () => {
        throw new Error("Notification not allowed") // iOS/Android page-context throw
      },
    })
    d.onNotification((e) => seen.push(e))

    expect(() => d.dispatch("notification", { id: "n1" })).not.toThrow()
    expect(seen).toEqual([{ id: "n1" }])
    err.mockRestore()
  })
})

// --- Downlink seam: one live source, decode-pump, close --------------------------------

/** Minimal manual source: a test pumps decoded messages and a close reason in. */
function makeSource(): DownlinkSource & { pumpEvent: (e: string, data: unknown) => void } & {
  pumpClose: (reason: string) => void
  detached: boolean
} {
  let onEvent: ((event: string, data: unknown) => void) | null = null
  let onClose: ((reason: string) => void) | null = null
  const src = {
    attach(h: { onEvent: (e: string, d: unknown) => void; onClose: (r: string) => void }) {
      onEvent = h.onEvent
      onClose = h.onClose
    },
    detach() {
      src.detached = true
    },
    detached: false,
    pumpEvent(e: string, data: unknown) {
      onEvent?.(e, data)
    },
    pumpClose(reason: string) {
      onClose?.(reason)
    },
  }
  return src
}

describe("createDownlink", () => {
  it("routes source events to the dispatcher and onClose listeners on close", () => {
    const dispatched: Array<[string, unknown]> = []
    const dispatcher = {
      dispatch: (kind: string, payload: unknown) => dispatched.push([kind, payload]),
    }
    const src = makeSource()
    const link = createDownlink(dispatcher, src)
    const closes: string[] = []
    link.onClose((r) => closes.push(r))
    src.pumpEvent("cdp", { method: "X" })
    expect(dispatched).toEqual([["cdp", { method: "X" }]])
    src.pumpClose("ws drop")
    expect(closes).toEqual(["ws drop"])
  })

  it("onClose unsubscribe removes the listener", () => {
    const dispatcher = { dispatch: () => {} }
    const src = makeSource()
    const link = createDownlink(dispatcher, src)
    const closes: string[] = []
    const off = link.onClose((r) => closes.push(r))
    off()
    src.pumpClose("x")
    expect(closes).toEqual([])
  })

  it("close() detaches the source and notifies onClose listeners once", () => {
    const dispatcher = { dispatch: () => {} }
    const src = makeSource()
    const link = createDownlink(dispatcher, src)
    const closes: string[] = []
    link.onClose((r) => closes.push(r))
    link.close()
    expect(src.detached).toBe(true)
    expect(closes).toEqual(["closed"])
  })

  it("only one source is live: a source's events stop reaching the dispatcher after close()", () => {
    const dispatched: Array<[string, unknown]> = []
    const dispatcher = { dispatch: (k: string, p: unknown) => dispatched.push([k, p]) }
    const src = makeSource()
    const link = createDownlink(dispatcher, src)
    link.close()
    // A stale source push after close must not reach the dispatcher.
    src.pumpEvent("cdp", { method: "late" })
    expect(dispatched).toEqual([])
  })

  it("a close reason fires the onClose listeners exactly once even on a late source close", () => {
    const dispatcher = { dispatch: () => {} }
    const src = makeSource()
    const link = createDownlink(dispatcher, src)
    const closes: string[] = []
    link.onClose((r) => closes.push(r))
    link.close()
    // Source emits its own late close after we already tore it down — must not double-fire.
    src.pumpClose("late")
    expect(closes).toEqual(["closed"])
  })
})
