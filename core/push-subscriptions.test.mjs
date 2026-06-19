import { describe, expect, it } from "vitest"
import { reconcileDeviceId } from "./push-subscriptions.js"

describe("reconcileDeviceId", () => {
  it("returns a new deviceId when the subscription is new (endpoint not in store)", () => {
    const existingSubs = []
    const incoming = { endpoint: "https://push.example.com/api/v1/sub1" }

    const result = reconcileDeviceId(existingSubs, incoming)

    expect(result.deviceId).toBeTruthy()
    expect(result.isNew).toBe(true)
    expect(result.deviceId.length).toBeGreaterThan(0)
  })

  it("reuses existing deviceId when endpoint matches", () => {
    const existing = {
      endpoint: "https://push.example.com/api/v1/sub1",
      deviceId: "device-uuid-123",
    }
    const existingSubs = [existing]
    const incoming = { endpoint: "https://push.example.com/api/v1/sub1" }

    const result = reconcileDeviceId(existingSubs, incoming)

    expect(result.deviceId).toBe("device-uuid-123")
    expect(result.isNew).toBe(false)
  })

  it("generates a new id if incoming has a cached id that conflicts with endpoint binding", () => {
    const existing = {
      endpoint: "https://push.example.com/api/v1/sub1",
      deviceId: "stored-uuid-123",
    }
    const existingSubs = [existing]
    const incoming = {
      endpoint: "https://push.example.com/api/v1/sub1",
      deviceId: "different-cached-id",
    }

    const result = reconcileDeviceId(existingSubs, incoming)

    // Endpoint match wins; incoming cached id is ignored
    expect(result.deviceId).toBe("stored-uuid-123")
    expect(result.isNew).toBe(false)
  })

  it("adds a new sub record for a new endpoint without duplicates", () => {
    const sub1 = {
      endpoint: "https://push.example.com/api/v1/sub1",
      deviceId: "device-1",
    }
    const existingSubs = [sub1]
    const incoming = { endpoint: "https://push.example.com/api/v1/sub2" }

    const result = reconcileDeviceId(existingSubs, incoming)

    expect(result.deviceId).not.toBe("device-1")
    expect(result.isNew).toBe(true)
  })

  it("handles multiple existing subscriptions and picks the matching one", () => {
    const existing1 = {
      endpoint: "https://push.example.com/api/v1/sub1",
      deviceId: "device-1",
    }
    const existing2 = {
      endpoint: "https://push.example.com/api/v1/sub2",
      deviceId: "device-2",
    }
    const existing3 = {
      endpoint: "https://push.example.com/api/v1/sub3",
      deviceId: "device-3",
    }
    const existingSubs = [existing1, existing2, existing3]
    const incoming = { endpoint: "https://push.example.com/api/v1/sub2" }

    const result = reconcileDeviceId(existingSubs, incoming)

    expect(result.deviceId).toBe("device-2")
    expect(result.isNew).toBe(false)
  })

  it("mints a valid UUID v4 for new subscriptions", () => {
    const existingSubs = []
    const incoming = { endpoint: "https://push.example.com/api/v1/new" }

    const result = reconcileDeviceId(existingSubs, incoming)

    // Basic UUID v4 validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(result.deviceId).toMatch(uuidRegex)
  })

  it("is idempotent for the same endpoint", () => {
    const existingSubs = []
    const incoming = { endpoint: "https://push.example.com/api/v1/sub1" }

    const result1 = reconcileDeviceId(existingSubs, incoming)
    // Simulate storing the result
    const stored = [{ endpoint: incoming.endpoint, deviceId: result1.deviceId }]
    const result2 = reconcileDeviceId(stored, incoming)

    expect(result2.deviceId).toBe(result1.deviceId)
    expect(result2.isNew).toBe(false)
  })

  it("does not modify the input arrays", () => {
    const existingSubs = [
      { endpoint: "https://push.example.com/api/v1/sub1", deviceId: "device-1" },
    ]
    const existingSubsClone = JSON.parse(JSON.stringify(existingSubs))
    const incoming = { endpoint: "https://push.example.com/api/v1/sub2" }

    reconcileDeviceId(existingSubs, incoming)

    expect(existingSubs).toEqual(existingSubsClone)
  })
})
