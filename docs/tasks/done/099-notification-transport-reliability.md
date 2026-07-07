# 099 — notification & transport reliability

- **Status:** done
- **Mode:** AFK (the only HITL bits are device-only iOS confirmations, carved out as **non-blocking** — see Test plan)
- **Estimate:** 2–3d (ships as ONE PR with 4 internal commit boundaries)
- **Depends on:** none (builds on t040/t042 reconnect, t056 paint-ack, t070/t098 keeper, t071 sweep, t093 per-device, t095 push identity)
- **Blocks:** none

## Goal

Close the reliability cluster the deep-review found: **push notifications silently stop on the phone** (four P1s), and the web server/client have recovery gaps that need a restart or manual reload to escape (P2s). After this task the daily-driver iPad/iPhone PWA keeps delivering notifications across a localStorage wipe, a subscription revocation, a Slack token rotation, and a server restart; the web server survives a half-open sleeping client, a crash mid-write, and a bad POST; and the client recovers from a rejected reconnect, a poisoned downlink, and a wake-from-suspend with a stale frame — all without human intervention. This is a reliability-only task: no new user-facing features, no UI redesign.

## Why now

The web PWA is the priority surface and exists to triage notifications (ADR-0012). The four P1s all end in "notifications silently stop" — the highest-severity failure the product has, because the user believes they are covered and misses everything with no signal. One of them (the push-revalidation stub) means t095's headline recovery fix **never actually runs** — the code is a `// TODO` that discards the gate result, and the SW-message listener is bound to the wrong target so it is dead on every platform. The P2 hardening rides along because the same subsystems are open, and a single PR keeps the reliability story coherent.

> **Scope note (grill 2026-07-07):** bundling all four commit areas exceeds the one-session half-day cap (~2–3d). Accepted by the user (chose the combined task knowingly). Land in dependency order with commit checkpoints — **C1 push recovery** → **C2 capture continuity** → **C3 server hardening** → **C4 client resilience**. If a session nears compaction, split at those seams rather than carrying a half-done cluster.

## Acceptance criteria

### C1 — push recovery (P1: revalidation stub + deviceId orphan)

- [ ] The app **actually re-validates** the push subscription on `visibilitychange` → visible: the existing once-per-foreground gate result is consumed (not discarded), and when it fires AND push intent is on, the effectful re-subscribe runs. The current `// TODO(t095-future)` no-op is gone.
- [ ] The SW→page message listener is bound to `navigator.serviceWorker` (the container), not `navigator.serviceWorker.controller`, so a `push-subscription-change` message is actually received. The `pushsubscriptionchange` SW path stays (dead on iOS, correct on Android/desktop).
- [ ] **Boot deviceId reconcile:** on web boot, if `pushManager.getSubscription()` returns a live subscription, the app calls `subscribePush(sub)` so the server reconciles the endpoint to its prior `deviceId`, and adopts the returned id **before** reading any device-keyed ui-state (`webPush_<id>`, `notifMutes_<id>`, `notificationsEnabled_<id>`). After a localStorage wipe, mutes/master/toggle again read the correct keys.
- [ ] **Intent = server flag:** after boot reconcile, if `webPush_<id> === false` the app unsubscribes (honoring a prior OFF choice); otherwise the live sub is kept. A live sub on boot normally implies push was on, so a wiped device self-heals silently.
- [ ] **Auto-subscribe only with recoverable intent:** a null subscription + fresh localStorage (no known deviceId) leaves push OFF (user re-enables via Settings — the wipe+revoked corner, documented as accepted). A null subscription + a known deviceId whose `webPush_<id> === true` re-subscribes (revocation recovery).
- [ ] The subscribe/unsubscribe/re-validate effect logic is lifted out of `settings-dialog.tsx` into a shared module so boot, the visibilitychange gate, and Settings all call one implementation (no duplicated subscribe path).

### C2 — Slack capture continuity (P1: stale creds + memory-only watermark)

- [ ] **Watermark survives restart:** `{ watermark, seeded }` is persisted to a new non-secret `slack-sweep-state.json` and loaded on boot. A team with a persisted watermark **resumes from it** (fetches history since the watermark, backfilling the downtime gap); only a genuinely-new team seeds from `latest`. The stale "cold start re-fetch (not re-notify)" comment is corrected.
- [ ] Persistence uses a **debounced (~2s trailing) atomic write** (write-temp → rename) and a **SIGTERM/SIGINT flush** that writes synchronously before exit. Seeding never re-fires notifications for messages already past the persisted watermark (store id-dedup makes a re-fetch idempotent).
- [ ] **Stale creds self-recover:** on `markCredsStale(team)` the notification center re-runs `extractSlackCreds` over the live side-channel socket (reads the fresh `localConfig_v2`). If the workspace is still stale on the next sweep AND the live Slack tab is the keeper's own anonymous parked tab, it `Page.reload`s that tab to force a fresh token. It **never** reloads a user-pinned Slack tab (t098) — for those it re-extracts only and lets the health surface degrade. No hijack-write fallback is added (ADR-0011 sole-writer invariant preserved; the persisted watermark backfills the heal-window gap).
- [ ] Slack notifications resume within one sweep cycle after a token rotation, with zero lost messages (delayed, not dropped) as long as the parked tab / a pin keeps one workspace live.

### C3 — server hardening (P2)

- [ ] **Liveness + backpressure:** the WS fan-out sends `ws.ping` on a heartbeat and `terminate`s + evicts (from `wsClients` and `paintAckClients`) a socket that misses the pong deadline. Per frame per client, if `ws.bufferedAmount` exceeds a cap the frame is **skipped for that client only** (fresh-frame-wins); a slow client is not disconnected, only a heartbeat-dead one is. A half-open sleeping iPad can no longer buffer frames unboundedly, and a dead paint-ack client can no longer pace every other viewer to ~1 fps.
- [ ] **Atomic JSON persistence:** `settings.json`, `web-push-subs.json`, `web-notifications.json`, `slack-workspaces.json`, and `slack-sweep-state.json` all write via a shared atomic write-temp-then-rename helper. A crash mid-write can no longer truncate/reset any of them.
- [ ] **Body validation:** an unparseable or undecryptable POST body yields a `400` (not a masked `{}`), and mutation routes shape-guard their input (config requires `{host,port}`-shaped; pins requires an array; etc.) so one malformed POST can no longer persist garbage that wipes pins or CDP config.
- [ ] **Sweep overlap guard:** the 15s `runOnce` backstop is single-flighted — a concurrent invocation is skipped while one is in flight, so a 429 `Retry-After` sleep can't stack duplicate sweeps into a rate-limit spiral.

### C4 — client resilience (P2)

- [ ] **Reconnect survives a rejected connect:** the auto-reconnect driver catches a rejected `/api/connect` POST and treats it as a failed attempt (schedules the next backoff) rather than letting the rejection escape the loop. The UI can no longer get wedged on "Reconnecting…" forever.
- [ ] **Downlink poison guard:** a single throwing listener or a single failed E2E decode no longer kills the downlink chain — each fan-out dispatch and each decode is guarded; a failed decode is dropped and counted, and a run of decode failures surfaces a "decryption failing / wrong passphrase" signal instead of silent death. The page-context `new Notification()` in `maybeToast` is guarded (it throws on iOS/Android).
- [ ] **Wake resync:** on `visibilitychange` → visible, the client probes for a fresh frame or pong within ~1.5s; if silent it calls the driver's `reconnectNow()` (t042). A frozen frame labeled "Connected" can no longer persist after a suspend that swallowed the `disconnected` broadcast.
- [ ] **Viewport quality fix:** the resize-triggered screencast reissue reads `jpegQuality` + `everyNthFrame` from the active quality tier (the same source the connect path uses) instead of hardcoding `quality: 80` and dropping `everyNthFrame`. A resize no longer silently overrides the user's tier or the t054 rate ceiling.
- [ ] **Health endpoint honors E2E:** the `/api/notifications/health` fetch routes through the same crypto bridge as every other `/api` call, so Grid grouping, exclude migration, and the health card work when `E2E_PASSPHRASE` is set.

### Cross-cutting

- [x] **AFK keystone e2e:** the hermetic `test/e2e/` harness (fake CDP host + `web/server.mjs`, isolated paths incl. the new `SLACK_SWEEP_STATE_PATH`) proves, with no device: (a) endpoint-rotation deviceId recovery — a new endpoint carrying a known `deviceId` re-binds it (C1); (b) a malformed POST body is a 400 with config untouched, and an empty-object config is a 400 that keeps the CDP address (C3). The reconnect-retry (client-side driver) and backpressure-skip (WS send predicate) paths are **unit-covered** (`web-reconnect-driver.test.ts`, `ws-backpressure.test.ts`) rather than e2e — the harness is HTTP-oriented and can't cheaply simulate a half-open WS client; noted honestly, not silently dropped.
- [x] No regression to `setAppBadge` mirroring, the deep-route `data` payload, `notificationclick`, tab-switch settle, the paint-ack gate, or the E2E wire format (full `pnpm test` + `pnpm test:e2e` green).

## Test plan

**AFK posture:** every gate below runs headlessly (`pnpm test`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm build`, `node --check`, `pnpm web` boot). Genuinely device-only iOS behaviors are isolated in a **non-blocking** post-merge checklist so the AFK agent can build, verify, and close on green automated gates.

### Layer 1 — Pure logic (TDD) — `pnpm test`

- [ ] `src/lib/push-lifecycle` — `planBootPush({ hasSub, knownIntent })` → `reconcile | resubscribe | noop`; `planPostReconcile({ serverWebPush })` → `keep | unsubscribe`. Covers: live sub → reconcile; no sub + intent on → resubscribe; no sub + unknown intent → noop; reconciled flag false → unsubscribe.
- [ ] `src/lib/push-revalidate` (existing) — assert the gate is actually consumed by adding a test that the foreground-revalidate decision = `gate.shouldRevalidateNow(visible) && intentOn` (guards the wired behavior, not just the gate).
- [ ] `core/slack-sweep-state` — `serialize`/`deserialize` round-trip of `{ watermark, seeded }` (Set ↔ array); `createSweepStatePersister({ read, write, now, setTimer })` debounce coalesces a burst into one trailing flush; `flushSync` writes immediately; load-on-boot returns `{}`-defaults on a missing/corrupt file.
- [ ] `core/atomic-write` — `atomicWriteFileSync(path, data, { fs })` writes to a temp path then renames; a write that throws leaves the original file intact (inject a failing fs).
- [ ] `core/ws-backpressure` — `shouldSkipClient(bufferedAmount, cap)` boolean; `livenessVerdict(lastPongAt, now, deadline)` → `alive | dead`.
- [ ] `core/request-guards` — `isValidConfig`, `isValidPins`, and a `parseBodyOrReject` sentinel: valid shapes pass, malformed/`null`/wrong-type reject.
- [ ] `core/sweep-overlap` (or extend `sweep-scheduler`) — a single-flight guard skips a concurrent `runOnce` while one is in flight and re-arms after it settles.
- [ ] `src/lib/wake-resync` — `planWakeResync({ visible, sawFrameWithinMs, sawPongWithinMs })` → `reconnect | noop`.
- [ ] `src/lib/web-reconnect-driver` (existing test) — add: a connect thunk that rejects schedules the next backoff and does not throw.
- [ ] `src/lib/downlink-dispatcher` (existing test) — add: a throwing listener does not prevent other listeners from receiving; a decode-throw is isolated to that message.

### Layer 2 — Automated integration (`pnpm test:e2e` + boot checks)

- [ ] **Sweep restart keystone:** start server, ingest a swept entry advancing a watermark, stop, restart with the same `SLACK_SWEEP_STATE_PATH` → the reloaded state resumes from the watermark (seed branch NOT taken); assert via the sweep runner's plan.
- [ ] **Reconnect keystone:** a `/api/connect` that rejects (fake host returns error) leaves the driver scheduling a retry (state observable), not a wedged terminal.
- [ ] **Backpressure keystone:** a simulated client whose `bufferedAmount` exceeds the cap is skipped for a frame while a second healthy client still receives it.
- [ ] `node --check web/server.mjs` + `node --check main.js`; `pnpm web` boots cleanly against the fake CDP host; existing `server.e2e.test.ts` + `resilience.e2e.test.ts` stay green.
- [x] **SW push-flow coverage** (unit): `buildNotificationContent` (`push-notification.test.ts`, pre-existing) covers the always-render/revocation-proof path incl. the null/garbage fallback; the boot deviceId-adopt path is covered by `push-lifecycle.test.ts` (decisions), `push-subscribe.test.ts` (subscribe→register→adopt with fakes), and the e2e reconcile suite. A full jsdom `ServiceWorkerGlobalScope` `push`-event simulation was **not** added — the SW is a static mirror and its lifecycle is awkward to fake hermetically (same rationale tdd.md gives for `sw-update.ts`); the mirrored logic is what's tested.

### Layer 3 — Visual review

- [ ] n/a — no renderer UI layout changes. The only user-visible surfaces are OS notifications, the status-bar connection state (recovers instead of freezing), and the screencast sharpness after resize (verified in the device checklist, not a screenshot diff).

### Post-merge device confirmation (HITL — NON-BLOCKING, does not gate AFK close)

Logged for the next real-device session; the automated gates above are sufficient to close AFK.

- [ ] Real installed iOS PWA: a lock-screen push arrives; the home-screen badge count is correct.
- [ ] Storage-wipe recovery: after a wipe + foreground, push still delivers and prior mutes/master are restored (server reconciled the same `deviceId`).
- [ ] Revocation recovery: a force-revoked subscription self-heals on the next foreground.
- [ ] Slack token rotation: notifications resume within a sweep cycle with no lost messages.
- [ ] Suspend/resume: waking the PWA after a network drop shows a live frame (no frozen "Connected"), and a resize keeps the chosen quality tier.

## Design notes

Describe behavioral contracts, not file paths.

- **Contracts changed:**
  - Boot push flow — `getOrCreateDeviceId` is no longer trusted forever; on web boot, a live subscription drives an endpoint reconcile that adopts the server's `deviceId` before any device-keyed read. The Settings toggle displays state derived from (live sub ∧ server flag), not localStorage alone.
  - Slack sweep state — was module-only in-memory; now `{ watermark, seeded }` is a persisted, reloaded contract with debounced-atomic write + shutdown flush. `markCredsStale(team)` gains a self-recovery side effect (re-extract over the live socket; conditional parked-tab reload).
  - WS fan-out — gains a per-client send predicate (skip on buffered-amount cap) and a heartbeat/eviction lifecycle; no wire-format change.
  - `POST` body handling — a parse/decrypt failure is a `400`, not a silent `{}`; mutation routes shape-guard.
  - Reconnect driver — a rejected connect is an internal failed attempt, never an escaped rejection.
  - `/api/notifications/health` — now crossed the crypto bridge like other `/api` calls (E2E-transparent).
- **New modules (all with a testable pure core):**
  - `src/lib/push-lifecycle.ts` — pure boot/post-reconcile planners.
  - `src/lib/push-subscribe.ts` — effectful subscribe/unsubscribe/re-validate glue lifted from `settings-dialog.tsx`, DI'd, importing the planners.
  - `src/lib/wake-resync.ts` — pure wake-resync decision.
  - `core/atomic-write.js` — atomic write-temp-rename helper (server + main).
  - `core/slack-sweep-state.js` — pure serialize/deserialize + DI'd debounced persister.
  - `core/ws-backpressure.js` — pure skip/liveness predicates.
  - `core/request-guards.js` — pure body/shape validation.
  - (sweep single-flight: extend `core/sweep-scheduler.js` if it fits, else `core/sweep-overlap.js`.)
- **New ADR needed?** **Yes — ADR-0016 "persist Slack sweep watermark across restarts."** Passes the 3/3 bar: hard to reverse (on-disk format + resume semantics), surprising to a future reader (why a new state file), a real trade-off (persist-and-resume vs memory-only; resume-from-watermark vs seed-from-`last_read`). Draft during C2 implementation once the shape is concrete. It extends ADR-0011 (which claimed cold-start was re-fetch-not-re-notify — this makes that true).

```ts
// C1 — pure boot planners (src/lib/push-lifecycle.ts)
type Intent = "on" | "off" | "unknown"
planBootPush(i: { hasSub: boolean; knownIntent: Intent }): "reconcile" | "resubscribe" | "noop"
//  hasSub               -> "reconcile"   (adopt server deviceId by endpoint)
//  !hasSub & on         -> "resubscribe" (recover revocation)
//  else                 -> "noop"        (fresh localStorage + no sub = leave OFF)
planPostReconcile(i: { serverWebPush: boolean }): "keep" | "unsubscribe"

// C2 — persisted sweep state (core/slack-sweep-state.js)
serialize(state: { watermark; seeded: Set }): { watermark; seeded: string[] }
createSweepStatePersister(deps: { read; write; now; setTimer; debounceMs })
//  .load() -> { watermark, seeded }   .scheduleFlush()   .flushSync()
```

## Out of scope

Captured as separate tasks / backlog:

- **t100 — durable client prefs:** move `qualityTier` / `inputTransport` / `latencyHud` off localStorage into device-keyed server ui-state (reuse the t093/t095 remap seam). Same wipe root cause, but a UI-persistence concern needing its own visual review of the Settings pickers.
- **Task/doc hygiene:** close the still-open `t096`/`t098` task files, diet the ~99KB `CLAUDE.md` + `src/lib/CLAUDE.md`, adopt `checkJs` for the untyped backend. Separate cleanup.
- **Feature backlog** (each its own task, not reliability): Slack reactions in the reader, inbox swipe triage, per-device quiet hours, Slack unread catch-up view, hardware-keyboard Telex/IME bridge, workspace-qualified push titles.
- Read-state cross-device sync (a silent push to sync would risk `userVisibleOnly` revocation on iOS); seed-from-`last_read` unread backfill (that's the catch-up feature); pausing the screencast when zero clients (an optimization, not the leak fix); the push-content threat model.
- Electron parity for any of the above (Electron is best-effort; the P2 client/server fixes are web-path).

## Definition of Done

**AFK completion gates — all required to close (no device needed):**

- [x] Layer 1 tests written and green (push-lifecycle, push-subscribe, slack-sweep-state, atomic-write, ws-backpressure, request-guards, wake-resync + reconnect-driver / downlink-dispatcher / quality-tier / push-subscriptions additions)
- [x] Layer 2 green: e2e keystones (endpoint-rotation recovery + body validation) pass; `node --check` both backends; server boots against the fake CDP host
- [x] `pnpm test` green (993); `pnpm test:e2e` green (47)
- [x] `pnpm typecheck` clean; `pnpm check:changed` exit 0 (Biome on the diff — warnings only, pre-existing); `pnpm build` clean
- [x] CLAUDE.md (core module index + sidechain bullet) + `src/lib/CLAUDE.md` (push-lifecycle / push-subscribe / wake-resync / quality-tier) updated
- [x] **ADR-0016 written** (persist Slack sweep watermark) — authored during C2
- [x] No commented-out code, no stray `console.log`, no AI attribution
- [x] Task closed: status → done, moved to `docs/tasks/done/`, `t099` in branch + commit
- [x] Branch `fix/t099-notification-transport-reliability`; 4 commits at the C1–C4 boundaries with semantic titles; **push + PR authorized by the user (grill 2026-07-07)**

**Non-blocking (do NOT gate AFK close):** the post-merge device confirmation checklist — run on the next device session and note results in the closed task.

## Notes

Origin: the ultracode deep-review workflow (2026-07-07) — 54 adversarially-verified findings; this task takes the confirmed P1 cluster + the notification/transport P2 hardening. Grilled via `/grill-with-docs`, spec via `/to-prd`.

**Verified findings driving each criterion (file:line at review time — verify before editing, paths drift):**
- Revalidation stub — `app.tsx:263` discards `shouldRevalidateNow()` behind a `// TODO(t095-future)`; the SW-message listener is on `navigator.serviceWorker.controller` (`app.tsx:367`) so it never receives (messages arrive on the container) — dead on ALL platforms, not just iOS. `reValidateSubscription` already exists whole at `settings-dialog.tsx:297`.
- deviceId orphan — `getOrCreateDeviceId` mints from localStorage (`cdp-web-transport.ts:46`, adopt seam at `:359`); after the documented iPad wipe, `webPush_<newId>` reads false while pushes keep arriving and mutes write to keys delivery never reads. The push **endpoint survives** the wipe (SW/IndexedDB), so `reconcileDeviceId(pushSubs, sub)` (`server.mjs:1079`) recovers the old id — a boot re-subscribe heals it.
- Stale creds — extraction only in `ws.on("open")` (`notifications-sidechain.js:229`); `markCredsStale` (`:361`) keeps last creds but nothing re-extracts. The parked-tab socket stays OPEN through a token rotation, so re-running `extractSlackCreds` over it reads the fresh `localConfig_v2`.
- Watermark memory-only — `slackSweepState` (`server.mjs:682`) is module-level; only settings/subs/notifs/workspaces persist. The `:680-681` comment claiming cold-start is "re-fetch not re-notify" is wrong — the seed branch skips the fetch (`slack-sweep-runner.js` seed path), so downtime messages are dropped.
- WS backpressure — `broadcastFrameBinaryRaw`/`broadcast` (`server.mjs:277`/`:357`) evict only on a send-throw, which never fires on a half-open socket; no `bufferedAmount`, `ws.ping`, or `terminate` anywhere. A dead paint-ack client keeps `paintAckActive()` true and the watchdog paces others to ~1 fps.
- Non-atomic writes — every persist is a bare `writeFileSync` (`:127`, `:141`, `:547`, `:612`).
- body() masking — a bad/undecryptable body becomes `{}`; mutation routes don't shape-validate.
- Sweep overlap — `setInterval(runOnce, 15s)` (`server.mjs:802`) has no in-flight guard; a 429 `Retry-After` sleep can stack sweeps.
- Reconnect wedge, downlink poison, frozen-frame-on-wake, viewport `quality:80` hardcode, `/api/notifications/health` raw-fetch — client-side, confirmed in the review (dimensions stability-client + drift).

**Grill decisions (2026-07-07):**
1. Scope = one combined task, one PR, 4 commit boundaries (C1–C4) in dependency order.
2. Push intent after reconcile = the durable server `webPush_<id>` flag; unsubscribe if false.
3. Auto-subscribe only with recoverable intent; the wipe+revoked corner is user-fixable (accepted).
4. Stale-cred recovery = re-extract over the live socket; reload only the keeper's own parked tab, never a user pin; no hijack-write fallback.
5. Watermark = new `slack-sweep-state.json`, debounced (~2s) atomic write + SIGTERM/SIGINT flush; resume-from-watermark for known teams, seed-from-`latest` for new.
6. WS backpressure = drop frames for an over-cap client; only the heartbeat disconnects.
7. Wake resync = probe on foreground, `reconnectNow()` if silent < ~1.5s.
8. Durable client prefs migration = deferred to t100.
9. Verify bar = green gates + mocked SW flow + a non-blocking device checklist.
10. Process = build + push + open PR (user authorized); 4 semantic commits, no AI attribution.

---

_When task status flips to `done`, move this file to `done/`._
