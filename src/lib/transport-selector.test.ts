import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTransportSelector, type InputTransportMode } from "./transport-selector"

describe("transport-selector", () => {
  let selector: ReturnType<typeof createTransportSelector>
  let cache: Record<string, string>

  const mockCache = {
    getItem: (key: string) => cache[key] ?? null,
    setItem: (key: string, val: string) => {
      cache[key] = val
    },
  }

  beforeEach(() => {
    cache = {}
    selector = createTransportSelector({ cache: mockCache })
  })

  describe("auto mode — fallback chain", () => {
    it("tries last-good from cache first", () => {
      mockCache.setItem("inputTransport_lastGood", "stream")
      const modes = selector.getAutoChain()
      expect(modes[0]).toBe("stream")
      expect(modes).toContain("batch")
    })

    it("defaults to ws if no cache", () => {
      const modes = selector.getAutoChain()
      expect(modes[0]).toBe("ws")
    })

    it("ignores stale cache value", () => {
      mockCache.setItem("inputTransport_lastGood", "invalid")
      const modes = selector.getAutoChain()
      expect(modes[0]).toBe("ws")
    })

    it("chain is ws → stream → batch when starting fresh", () => {
      const modes = selector.getAutoChain()
      expect(modes).toEqual(["ws", "stream", "batch"])
    })
  })

  describe("retries", () => {
    it("allows 3 retries on the same mode before falling back", () => {
      let attempt = 0
      const onRetry = vi.fn((mode) => {
        attempt++
        if (attempt < 3) {
          selector.recordRetry(mode, false) // fail
        } else {
          selector.recordRetry(mode, true) // succeed on 3rd
        }
      })

      const mode = "ws"
      for (let i = 0; i < 3; i++) {
        onRetry(mode)
      }

      expect(onRetry).toHaveBeenCalledTimes(3)
      expect(selector.isBlocked(mode)).toBe(false)
    })

    it("falls back after 3 failed retries on the same mode", () => {
      const mode = "ws"
      selector.recordRetry(mode, false)
      selector.recordRetry(mode, false)
      selector.recordRetry(mode, false)

      expect(selector.shouldDowngrade(mode)).toBe(true)
    })

    it("resets retry count on success", () => {
      const mode = "stream"
      selector.recordRetry(mode, false)
      selector.recordRetry(mode, true)
      selector.recordRetry(mode, false)
      selector.recordRetry(mode, false)

      // After success, only 2 failures before next downgrade
      expect(selector.shouldDowngrade(mode)).toBe(false)
      selector.recordRetry(mode, false)
      expect(selector.shouldDowngrade(mode)).toBe(true)
    })
  })

  describe("cache management", () => {
    it("caches the last-good mode on success", () => {
      selector.cacheSuccess("stream")
      expect(mockCache.getItem("inputTransport_lastGood")).toBe("stream")
    })

    it("does not cache the mode on failure", () => {
      selector.cacheSuccess("ws")
      selector.cacheFail("ws")
      expect(mockCache.getItem("inputTransport_lastGood")).toBe("ws")
    })
  })

  describe("manual mode selection", () => {
    it("allows explicit mode pick", () => {
      selector.setManualMode("batch")
      expect(selector.getActiveMode()).toBe("batch")
    })

    it("clears manual pick on fallback", () => {
      selector.setManualMode("ws")
      selector.fallbackToAuto()
      expect(selector.isManualMode()).toBe(false)
    })

    it("shows 'unavailable' message for manual mode on failure", () => {
      selector.setManualMode("ws")
      selector.recordFailure("ws")
      expect(selector.hasManualModeError()).toBe(true)
    })
  })

  describe("degraded state and re-probe", () => {
    it("tracks degraded state when downgrading from ws to stream", () => {
      selector.recordDowngrade("ws", "stream")
      expect(selector.isDegraded()).toBe(true)
      expect(selector.getDegradedFrom()).toBe("ws")
    })

    it("allows re-probe when degraded and tab refocused", () => {
      selector.recordDowngrade("ws", "stream")
      const nextProbe = selector.onFocus()
      expect(nextProbe).toBe("ws")
    })

    it("does not re-probe if already active on the ideal mode", () => {
      selector.cacheSuccess("ws")
      const nextProbe = selector.onFocus()
      expect(nextProbe).toBeNull()
    })
  })
})
