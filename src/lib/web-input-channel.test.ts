import { describe, expect, it, vi } from "vitest"
import type { WebTransportDeps } from "./cdp-web-transport"
import type { Batch } from "./input-coalesce"
import { createInputChannel } from "./web-input-channel"

// A fetch that never settles — models the streaming probe hanging (no SSE stream-ack), so the
// channel never flips to "streaming". Keeps the test deterministic regardless of whether the
// env reports request-streaming support.
function makeDeps(): WebTransportDeps {
  return {
    fetch: vi.fn(() => new Promise<Response>(() => {})),
    EventSource: vi.fn() as unknown as typeof EventSource,
    WebSocket: vi.fn() as unknown as typeof WebSocket,
  }
}

const batchOf = (method: string): Batch<{ method: string; params?: unknown }> => ({
  items: [{ method }],
  seq: 0,
})

describe("createInputChannel", () => {
  it("routes sends to the POST fallback until the stream is confirmed", () => {
    const postFallback = vi.fn()
    const ch = createInputChannel(makeDeps(), postFallback)

    const b = batchOf("Input.dispatchMouseEvent")
    ch.send(b)

    // No stream-ack (SSE) has confirmed the channel yet, so it is never in "streaming" —
    // regardless of whether the env supports request streaming — and the fallback owns the send.
    expect(postFallback).toHaveBeenCalledWith(b)
  })
})
