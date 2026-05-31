import { describe, expect, it } from "vitest"
import { shouldOfferReconnect } from "./status-bar"

describe("shouldOfferReconnect", () => {
  it("offers reconnect in the terminal disconnected state (post-ceiling, t040)", () => {
    expect(shouldOfferReconnect("Error: Disconnected")).toBe(true)
  })

  it("offers reconnect on any connect failure", () => {
    expect(shouldOfferReconnect("Error: ECONNREFUSED")).toBe(true)
  })

  it("does not offer reconnect while the loop is reconnecting", () => {
    expect(shouldOfferReconnect("Reconnecting…")).toBe(false)
  })

  it("does not offer reconnect on a live / idle / connecting status", () => {
    expect(shouldOfferReconnect("Connecting...")).toBe(false)
    expect(shouldOfferReconnect("No tab selected")).toBe(false)
    expect(shouldOfferReconnect("")).toBe(false)
  })
})
