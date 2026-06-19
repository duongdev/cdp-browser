# 0014 — Endpoint-reconciled per-device push identity

**Date:** 2026-06-20  
**Status:** Accepted  
**Deciders:** t095 (E0)

## Context

Web Push on iOS PWA (16.4+) requires stable per-device identity to survive storage eviction:

- **The problem:** localStorage, IndexedDB, cookies, Cache API, and SW registration are evicted together when iOS needs storage (or on install/uninstall). A locally-generated `deviceId` cached in localStorage orphans the push subscription binding and forgets per-device prefs (mute keys, master on/off) on the next app launch after a wipe.

- **The storage-layer contract:** The push endpoint URL (from `pushManager.subscribe()`) is the **only** identity that outlives storage eviction, because:
  1. The browser's push manager remembers which endpoints are subscribed (the Push Notification API state is OS-level, not script-storage).
  2. A re-subscribe to the same endpoint (same keys) is indistinguishable from the original.
  3. The endpoint is public (sent to the server on every subscribe POST).

- **The per-device state problem (t093):** Per-device settings (master on/off, mute keys) are keyed by `deviceId` in ui-state (`notificationsEnabled_<deviceId>`, `notifMutes_<deviceId>`, `webPush_<deviceId>`). A lost or regenerated `deviceId` severs the link to these prefs, forcing the user to re-configure after a wipe.

## Decision

**The server becomes the authoritative source of `deviceId`, reconciled by push subscription endpoint.**

Flow:
1. Client calls `POST /api/notifications/subscribe` with only the `endpoint` (not `deviceId`).
2. Server checks: does this endpoint already exist in `pushSubs`?
   - **Yes:** return its stored `deviceId`; endpoint match wins (ignore any cached client-sent id).
   - **No:** generate a new UUID v4, store it with the endpoint, return it.
3. Client receives the reconciled `deviceId` and adopts it as the single source for device-keyed ui-state keys.
4. Client stores the returned `deviceId` in localStorage as a cosmetic cache (for immediate reads before server round-trip), but trusts the server's reconciled id on every subscribe.

### Why endpoint-keyed, not hash-keyed

Alternative considered: hash the endpoint (e.g., sha256 base64 first 16 chars) and use that as the deviceId.

- **Tradeoff:** A hash is deterministic (survives reload) but loses information (can't inspect logs) and requires pre-hashing on client to match the server's key (another point of skew). A UUID is opaque and paired with the endpoint in the record, so logs are greppable and the binding is explicit.
- **Decision:** UUIDs + explicit endpoint records are clearer for debugging and testing; the server is already reconciling anyway.

## Consequences

### Positive

- After a storage wipe + re-subscribe to the same endpoint, the device recovers its prior `deviceId` (and thus prior mutes/master).
- No device can accidentally double-subscribe on the same endpoint (server dedupes by endpoint, not by `deviceId`).
- The subscription record is the source of truth; client-side caches can drift without breaking anything (only used for immediate UI reads).
- Per-device prefs (t093) survive the lifecycle naturally without special migration logic.

### Negative

- If the push endpoint changes (e.g., a browser re-generates it), a new `deviceId` is minted and the device gets a fresh (opt-out) prefs set. This is correct but invisible to the user — they'll see all notifications until they reconfigure (rare in practice; browsers are sticky with endpoints).
- The endpoint URL is logged server-side and persisted to disk (the `web-push-subs.json` file). If that file is exposed, the endpoints (but not the credentials) leak. Mitigation: endpoints are public by definition (sent on subscribe); the real secret is the `keys.auth` field, which is kept in the file too but never logged.

## Links

- **ADR-0013:** Per-device delivery gates (t093); this ADR extends it by making `deviceId` server-authoritative.
- **Task t095:** Harden Web Push delivery reliability (E0 implementation).
- **Test:** `test/e2e/server.e2e.test.ts` — push subscription reconcile e2e keystone tests the endpoint-matching logic end-to-end.
