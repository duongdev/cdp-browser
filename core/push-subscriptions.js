// Pure subscription reconciliation: server-authoritative deviceId keyed by endpoint.
// After a storage wipe, the same endpoint recovers its prior deviceId and per-device prefs.

import { randomUUID } from "crypto"

export function reconcileDeviceId(existingSubs, incoming) {
  const existing = existingSubs.find((sub) => sub.endpoint === incoming.endpoint)

  if (existing && existing.deviceId) {
    // Endpoint match wins; ignore any cached deviceId from the client
    return { deviceId: existing.deviceId, isNew: false }
  }

  return { deviceId: randomUUID(), isNew: true }
}
