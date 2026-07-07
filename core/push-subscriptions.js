// Pure subscription reconciliation: server-authoritative deviceId keyed by endpoint.
// After a storage wipe, the same endpoint recovers its prior deviceId and per-device prefs.

import { randomUUID } from "crypto"

export function reconcileDeviceId(existingSubs, incoming) {
  const existing = existingSubs.find((sub) => sub.endpoint === incoming.endpoint)

  if (existing && existing.deviceId) {
    // Endpoint match wins — recovers a storage-wiped device that kept the same push endpoint.
    // A cached client id that conflicts with the stored binding is ignored.
    return { deviceId: existing.deviceId, isNew: false }
  }

  // New endpoint. Adopt the client's self-asserted deviceId when it has one: after a
  // revocation/rotation the endpoint changes but the device keeps its id, and the per-device
  // prefs live in ui-state keyed by that id (not in the subs file), so re-binding the id to
  // the new endpoint restores them instead of orphaning. Single-user tailnet tool — the client
  // is trusted to name its own device. Only mint when the client sends no id at all (legacy).
  if (incoming.deviceId) {
    const known = existingSubs.some((sub) => sub.deviceId === incoming.deviceId)
    return { deviceId: incoming.deviceId, isNew: !known }
  }

  return { deviceId: randomUUID(), isNew: true }
}
