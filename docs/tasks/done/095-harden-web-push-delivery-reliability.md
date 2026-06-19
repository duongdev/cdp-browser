# 095 — harden web push delivery reliability

- **Status:** done
- **Mode:** AFK (the only HITL bits are device-only iOS confirmations, carved out as **non-blocking** — see Test plan)
- **Estimate:** 2d
- **Depends on:** none (builds on t066 subscribe, t080 push, t093 per-device delivery)
- **Blocks:** the deferred push roadmap (E3/E5/E7/E8 all assume a live, recoverable subscription — see Out of scope)

## Goal

Make the web-build Web Push subscription **stay alive, recoverable, and timely** on the daily-driver iPad PWA. Three coupled fixes ship together because they form one story — "a push subscription that survives the things iOS does to it":

1. **E1 — revocation-proof the service worker.** `public/sw.js`'s `push` handler returns early (no `showNotification`) on a payload with no data or a JSON-parse failure. On iOS that is a `userVisibleOnly` violation, and WebKit revokes the subscription on violation — with **no documented grace count**. After this, every `push` event renders something (the real notification, or a generic "New message" fallback), so a bad payload can never put the subscription at risk.
2. **E0 — make per-device identity survive a storage wipe.** `deviceId` lives in `localStorage`, which is wiped on the iPad PWA (and IndexedDB/cookies/Cache are wiped in the *same* eviction, so they're no escape). A regenerated `deviceId` orphans the subscription binding and resets every t093 per-device pref (mutes, master). After this, `deviceId` is **server-authoritative, reconciled by the push subscription endpoint** (the only identity that can outlive a script-storage wipe); `localStorage` is a cosmetic cache.
3. **E1b — recover a dead subscription on app foreground.** `pushsubscriptionchange` never fires on iOS PWAs, so the SW's re-subscribe path (`sw.js`) is dead there; today re-validation only happens if the user opens Settings. After this, the app re-validates/re-subscribes on `visibilitychange` (foreground), the only recovery hook iOS leaves — so opening the PWA heals a silently-revoked subscription.

Plus a delivery-tuning slice: the single `webpush.sendNotification` call sends with no `urgency`/`TTL`, so a triage ping can be battery-deferred and an undeliverable one lingers ~4 weeks and resurrects stale. After this it sends `urgency: "high"` + `TTL: 1800`.

## Why now

The web PWA is the priority surface and exists to triage notifications (ADR-0012). A silently-revoked or orphaned push subscription is the highest-severity failure the product has: the user believes they are covered and silently misses everything, with no signal and no self-recovery on iOS. Every deferred push improvement (conversation collapse, Topic header, clear-on-read, VAPID-env rotation) assumes a subscription that stays alive — so this reliability core lands first.

> **Scope note (conscious decision, grilling 2026-06-20):** bundling E1 + E0 + E1b exceeds the half-day one-session cap (~2d). Accepted by the user. Land in dependency order with commit checkpoints — **E1 first** (the urgent P0, `sw.js`-only), then **E0** (identity), then **E1b** (recovery, needs E0). If a session nears compaction, split at those seams rather than carrying a half-done cluster.

## Acceptance criteria

- [ ] **E1:** the SW `push` handler **always** calls `showNotification` — real notification for a valid payload; generic fallback (title "New message", empty body, fixed `tag: "cdp-fallback"`) for `!e.data`, a `e.data.json()` throw, or any processing error. No code path returns without showing.
- [ ] **E1:** notification-content shaping (title + options incl. the fallback branch) is a pure, unit-tested `buildNotificationContent(data)` in `src/lib/`, mirrored into `public/sw.js` (the `sw-cache-name.ts` pattern — a static SW can't import the module).
- [ ] **E0:** `deviceId` is server-authoritative. `POST /api/notifications/subscribe` reconciles by endpoint — an incoming subscription whose `endpoint` matches a stored record reuses that record's `deviceId`; otherwise it mints one — and **returns the reconciled `deviceId`**. The renderer adopts the returned id as the single source for all device-keyed ui-state (`notifMutes_<id>`, `notificationsEnabled_<id>`, `webPush_<id>`); `localStorage` is only a cache.
- [ ] **E0:** the reconcile decision is a pure, unit-tested helper in `core/` (server side); a wiped client that re-subscribes with the same endpoint recovers its prior `deviceId` (and thus its prior mutes/master), and no duplicate sub record accrues for the same endpoint.
- [ ] **E1b:** the app re-validates/re-subscribes on `visibilitychange` → visible, gated **once-per-foreground** + debounced, via a pure, unit-tested "should-revalidate-now" decision helper in `src/lib/`. The existing settings-open call stays; the dead `push-subscription-change` path is left as-is (harmless, still correct on non-iOS).
- [ ] **E2-tuning:** `webpush.sendNotification` is called with options from a pure, tested `pushSendOptions()` returning `{ urgency: "high", TTL: 1800 }`; both entry pushes and Slack health alerts inherit it (one call site). No `contentEncoding` added (`aes128gcm` is already the default — a no-op).
- [ ] **AFK keystone:** an e2e test (the `test/e2e/` fake-CDP + `web/server.mjs` harness, isolated `SUBS_PATH`) proves the reconcile end-to-end: subscribe with endpoint E1 → `{deviceId:D1}`; re-subscribe E1 → same `D1` + no duplicate sub record; subscribe E2 → a different id.
- [ ] **E4-guard:** a test asserts the Slack health-alert payload's `muteKey` equals `slack:{groupId}` (locks the t093 stamping that is correct today).
- [ ] No behavior change to `setAppBadge` mirroring, the deep-route `data` payload, `notificationclick`, or the push-content threat model (content still rides RFC 8291-encrypted; no app-layer E2E seal added — that's an E6 concern).

## Test plan

**AFK posture:** every gate below runs headlessly (`pnpm test`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm build`, `node --check`, `pnpm web` boot). The genuinely device-only iOS behaviors are isolated in a **non-blocking** post-merge section so an AFK agent can build, verify, and close on green automated gates. Residual risk is accepted (see Notes): the iOS guarantees are asserted by pure logic + e2e + spec, with the changed SW/renderer parts being thin glue that mirrors tested helpers.

### Layer 1 — Pure logic (TDD) — AFK, `pnpm test`

- [ ] `src/lib/<push-notification>` — `buildNotificationContent` returns the real `{title, options}` for a valid payload (`tag = data.id`, deep-route `data`, icon/badge/timestamp) and the fallback `{title:"New message", options:{tag:"cdp-fallback"}}` for `null`/`undefined`/parse-failure (covers the two `sw.js` early-return branches).
- [ ] `core/<push-subscriptions>` — `reconcileDeviceId(existingSubs, { endpoint, deviceId? })`: matching endpoint → reuse stored `deviceId`; new endpoint → mint; an incoming cached `deviceId` that conflicts with the endpoint's stored binding → endpoint wins. Idempotent; no duplicate record per endpoint.
- [ ] `src/lib/<push-revalidate>` — the once-per-foreground/debounce decision (visible + not-already-revalidated-this-foreground + push-enabled → revalidate; hidden→visible resets the gate). **Distinct from** the new `usePullToRefresh`/`refreshNotifications` (that re-fetches the notif *list*, not the push *subscription* — don't conflate).
- [ ] `core/<quality-tier-style helper>` — `pushSendOptions()` returns `{ urgency:"high", TTL:1800 }` (makes the header value a tested source, not a buried literal).
- [ ] `core/notif-mutes` (or server test) — `muteKey` of `{adapter:"slack", groupKey:"slack:{groupId}"}` resolves to `slack:{groupId}` (E4 regression guard).

### Layer 2 — Automated integration (AFK, `pnpm test:e2e` + boot checks)

- [ ] **e2e reconcile (keystone):** in `test/e2e/server.e2e.test.ts` via `startWebServer` (isolated `SUBS_PATH`) — `POST /api/notifications/subscribe` returns `{ deviceId }`; same endpoint twice → same id + single sub record; a second endpoint → a distinct id. Proves E0 end-to-end with no device.
- [ ] `node --check web/server.mjs`; `pnpm web` boots cleanly against the fake CDP host; existing e2e suite (`server.e2e.test.ts`, `resilience.e2e.test.ts`) still green.

### Layer 3 — Visual review

- [ ] n/a — no renderer UI changes (the push toggle / settings card are untouched). The fallback banner is an OS notification.

### Post-merge device confirmation (HITL — NON-BLOCKING, does not gate AFK close)

Logged for the next real-device session; the automated gates above are sufficient to close the task AFK.

- [ ] Real installed iOS PWA: a malformed/decrypt-failed push shows the generic banner and does **not** revoke the subscription.
- [ ] Storage-wipe recovery: after a wipe + foreground re-subscribe with the same endpoint, prior mutes/master are restored (server reconciled the same `deviceId`).
- [ ] Foreground re-validate fires once on `visibilitychange`; `urgency:"high"` notifications arrive promptly.

## Design notes

- **Contracts changed:**
  - `POST /api/notifications/subscribe` response — was `void`, now `{ deviceId }` (the reconciled id). The renderer's `subscribePush`/`reValidateSubscription` adopt it; `getOrCreateDeviceId` becomes "adopt the server's id, cache locally" rather than "mint locally, trust forever."
  - `webpush.sendNotification(sub, data)` — gains an options object `{ urgency: "high", TTL: 1800 }`.
  - SW `push` handler invariant — **must** end in `showNotification` on every path.
- **New modules:**
  - `src/lib/push-notification.ts` — pure `buildNotificationContent` + the fallback constant (lets the fallback logic be TDD'd; SW mirrors it like `sw-cache-name.ts`).
  - `core/push-subscriptions.js` — pure `reconcileDeviceId(existingSubs, incoming)` (server-side, so `server.mjs` uses the CJS copy and it's unit-tested).
  - `src/lib/<push-revalidate>.ts` — pure once-per-foreground gate (small; could fold into an existing module if it stays tiny).
- **New ADR needed?** Yes — **ADR-0014 "endpoint-reconciled per-device push identity"**, but **deferred to E0 implementation** (grilling decision): write it once the reconcile mechanics are concrete. It extends ADR-0013 (per-device delivery): `deviceId` server-authoritative + reconciled by endpoint *because* localStorage/IndexedDB are wiped together on iOS and the push endpoint is the only stable identity; records the tradeoff vs re-keying all per-device ui-state by an endpoint hash, and the `userVisibleOnly`-revocation hardening rationale.

```ts
// E1 — pure, mirrored into public/sw.js
function buildNotificationContent(data: PushData | null | undefined):
  { title: string; options: NotificationOptions }
// valid  -> { title: data.title ?? "CDP Browser", options: { body, icon, badge, tag: data.id, timestamp, data } }
// absent -> { title: "New message", options: { tag: "cdp-fallback", badge } }

// E0 — pure, server side
function reconcileDeviceId(
  existingSubs: { endpoint: string; deviceId?: string }[],
  incoming: { endpoint: string; deviceId?: string },
): { deviceId: string; isNew: boolean } // endpoint match wins over the incoming cached id
```

## Out of scope

Deferred push roadmap (each its own task; E0/E1b are NO LONGER deferred — they're in this task):

- **E3 — collapse a conversation** (tag by `groupKey`): a **product-taste decision** — iOS tag-replace is silent (no `renotify`), so 2nd..Nth messages in a thread wouldn't re-alert. Needs sign-off; must not ride a hardening task.
- **E5 — `Topic` header** for pre-delivery collapse of queued same-conversation pings (sha256(groupKey) base64url ≤32 chars).
- **E7 — clear-on-read banners + foreground `setAppBadge` self-heal** (also fixes the master-off badge-staleness path).
- **E8 — VAPID keys env-only** (fail loud on the baked default) + real subject; sequence after this task (a rotation invalidates all subs, and recovery now exists via E1b).
- **E6 — Declarative Web Push** (iOS 18.4+). Real E2E tension lives **here**: the OS renders a declarative payload without running the SW, so the app's AES-GCM E2E layer can't decrypt it → declarative content can't be app-E2E-sealed. Needs a policy (content-free under E2E?) + an 18.4 device.
- **E9 — Electron notification parity** (route OS toast + dock badge through `core/notif-mutes`, add id/icon/subtitle).
- **E10 — server-side triage ladder** (mention-only scope, quiet hours, snooze, keywords) — per-device ui-state like t093.

Also out of scope: any `localStorage` persistence for durable prefs; cross-device read-state sync (impossible silently on iOS — a silent push would revoke the sub); changing the push-content threat model.

## Definition of Done

**AFK completion gates — all required to close (no device needed):**

- [ ] Layer 1 tests written and green (`buildNotificationContent`, `reconcileDeviceId`, the foreground-revalidate gate, `pushSendOptions`, the `muteKey` guard)
- [ ] Layer 2 green: the e2e reconcile keystone test passes; `node --check web/server.mjs`; `pnpm web` boots against the fake CDP host
- [ ] `pnpm test` green; `pnpm test:e2e` green
- [ ] `pnpm typecheck` clean; `pnpm check:changed` clean (Biome on the diff); `pnpm build` clean
- [ ] CLAUDE.md (web-build push bullet) + `src/lib/CLAUDE.md` (new modules) updated
- [ ] CONTEXT.md gains *Web Push Subscription* + *userVisibleOnly revocation* (done during grilling)
- [ ] **ADR-0014 written** (endpoint-reconciled per-device push identity) — authored during E0 implementation
- [ ] No commented-out code, no stray `console.log`, no AI attribution
- [ ] Task closed: status → done, moved to `docs/tasks/done/`, `t095` in branch + commit

**Non-blocking (do NOT gate AFK close):** the post-merge device confirmation checklist (real iOS PWA no-revocation, storage-wipe recovery, foreground re-validate) — run on the next device session and note results in the closed task.

## Notes

Origin: a notification-pipeline investigation + internet deep-research pass (Electron + PWA push), synthesized and adversarially reviewed, then grilled (`/grill-with-docs`, 2026-06-20).

**Verified findings:**
- `sw.js` returns without `showNotification` on `!e.data` and on `e.data.json()` throw → iOS `userVisibleOnly` violation → subscription revoked, **no documented grace count**, no recovery (`pushsubscriptionchange` is dead on iOS PWAs).
- `webpush.sendNotification` is called with no options. `aes128gcm` is already the default encoding (the "add contentEncoding" idea was a no-op — cut).
- The Slack health-alert **already** stamps `adapter`/`groupKey` (t093) — the originally-proposed "muteKey resolves undefined" bug **does not exist**; only a regression test was salvaged (E4).
- There is **one** `webpush.sendNotification` site (`sendPushToAll`); both entry pushes and health alerts route through it, so the header fix lands once.
- **Plan re-checked against `main` @ `83e6397`** (phone keyboard-follow / nav-stack / pull-to-refresh + cmd-shortcut fix): `sw.js`, `server.mjs`, `core/*` untouched (E1/E2/E4 intact); `cdp-web-transport.ts` change was E2E-bootstrap mount-safety only (`getOrCreateDeviceId`/`subscribePush` unchanged → E0 intact); `settings-dialog.tsx` change was safe-area padding only (`reValidateSubscription` unchanged → E1b intact). `app.tsx` now has a phone nav stack + `usePullToRefresh`/`refreshNotifications`, but **no `visibilitychange` handler** — E1b adds its own foreground hook and stays distinct from pull-to-refresh (which re-fetches the notif *list*, not the *subscription*).
- iOS evicts **all** script-writable storage together (localStorage, IndexedDB, cookies, Cache, SW registration). Installed home-screen PWAs are *exempt* from the 7-day cap per spec — but the user has empirically observed localStorage resetting on the iPad PWA (MEMORY `localstorage-resets-in-pwa`, 2026-05-30), so E0 does not bet on localStorage surviving. Sources: [WebKit 7-day cap](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), [Search Engine Land summary](https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519), [MagicBell PWA iOS guide](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide).

**Grilling decisions (2026-06-20):**
1. Scope = bundle E1 + E0 + E1b + E2-tuning + E4-guard (the full reliability cluster), accepting the >1-session size with commit checkpoints in dependency order (Q1).
2. E0 = server-authoritative `deviceId` reconciled by subscription endpoint; localStorage is a cache; subscribe returns the id; renderer adopts it (Q2).
3. E1b trigger = app-foreground `visibilitychange`, once-per-foreground + debounced, pure decision helper; keep settings-open (Q3).
4. E2E ↔ push content = no change this task; the real tension is declarative-push-only → flagged on E6.
5. TTL = 1800s; fallback = "New message"/empty/`cdp-fallback`; extraction = `src/lib/push-notification.ts` mirrored into `sw.js`, `urgency`/`TTL` inline in `sendPushToAll`.
6. ADR-0014 deferred to E0 implementation (Q4).

---

_When task status flips to `done`, move this file to `done/`._
