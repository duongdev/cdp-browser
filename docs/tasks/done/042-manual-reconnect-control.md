# 042 — one-tap manual Reconnect control

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Slice:** 1-never-stuck
- **Ring:** inner
- **Depends on:** auto-reconnect-on-real-drop (t040)
- **Blocks:** none

## Goal

When the link to the Remote Browser is down — auto-reconnect is mid-backoff, or it
already gave up at the ceiling and the status settled on terminal "Disconnected" —
the user today has no way to force a retry except reloading the PWA. On iPad there
is no F5; a reload drops the whole session. After this task there is a one-tap
**Reconnect** control the user can hit anytime to force-reconnect the Remote Page
immediately. It is surfaced in two places: an affordance in the status bar's
terminal "Disconnected" state, and a Reconnect button in the settings drawer's
Connection card. Tapping it tears down any pending backoff timer, resets the
backoff schedule to its base delay, and invokes the connector's existing `connect`
entry point for the current Active Tab — it does **not** spin a competing loop. The
control is idempotent: rapid taps don't stack concurrent connects, because the retry
flows through the same `connectId` race-guard t040 already established. When the
session is healthy the control stays out of the way — it's only prominent while
disconnected or reconnecting, so a live session isn't cluttered.

## Why now

This is the escape-hatch half of the **1-never-stuck** slice and the second
obligation (after t040) of [product.md](../conventions/product.md)'s never-stuck
contract. t040 makes the app self-heal on a real drop with bounded backoff — but
"bounded" means it can give up: past the max-attempts ceiling it settles on a
terminal "Disconnected" state and stops retrying, to avoid a forever-loop. At that
point the user is stuck unless they can hand the loop a kick. On a Mac that's a
reload; on the iPad PWA — the daily-driver surface — there is no reload affordance
worth using (it drops the session). A zero-friction manual Reconnect is the
guaranteed way back without reloading. It depends on t040 because it reuses that
task's `connect` entry point and backoff state rather than owning its own retry
counter: t040 lands *the* backoff loop, t042 gives the user a button into it. It
also pre-stages t058 (the ⌘K command palette, outer ring), which will register a
"Reconnect" command pointing at this same entry point — the palette wiring is out of
scope here, but the action it will call lands now.

## Acceptance criteria

- [ ] A visible **Reconnect** affordance appears in the status bar's terminal
      "Disconnected" state (the post-ceiling state t040 settles on), alongside the
      existing "Connection settings" affordance.
- [ ] A **Reconnect** button appears in the settings drawer's **Connection** card.
- [ ] Tapping either control **immediately** tears down any pending backoff timer,
      resets the backoff schedule to its base delay, and invokes the connector's
      `connect` for the current/active tab — it reuses t040's single loop and entry
      point, never starting a second competing retry loop or counter.
- [ ] **Idempotent / debounced:** rapid taps don't stack multiple concurrent
      connects — the retry flows through t040's existing `connectId` race-guard, so a
      second tap supersedes the first (the earlier socket, if it resolves late, is
      discarded — never promoted, never emits frames). Exactly one live screencast in
      CDP `/json` after it settles.
- [ ] Works on the **web/PWA path** (the primary surface): the control drives the
      connector's `connect` through the web transport with no second socket and no
      duplicate `onEvent`/`onClose` listeners after recovery.
- [ ] On a coarse pointer the control's effective tap area is **≥44×44pt** (cross-ref
      t048's `@media (pointer: coarse)` hit-target rule — apply the same hit-slop
      pattern, don't re-derive it).
- [ ] **Behavior-preserving when connected:** a healthy session does not show a
      prominent Reconnect affordance in the status bar (the bar is hidden when idle,
      as today); the settings-drawer button is unobtrusive and never triggers a
      disconnect — it's connect-only. No status flicker, no extra connects on a
      session that never drops.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md): the control mostly calls into
t040's connector loop, so there is little-to-no new pure logic — Layer 1 applies
only if a small "should-show-reconnect" predicate is extracted. The
force-reconnect-into-the-loop wiring is CDP/WS glue → manual smoke (Layer 2). The
two affordances are a small renderer change → visual review (Layer 3).

### Layer 1 — Pure logic (TDD)

- [ ] If a pure predicate is extracted (e.g. `shouldOfferReconnect(status)` →
      derive "show the prominent Reconnect affordance" from the terminal-disconnected
      status string), TDD it: true only in the terminal state, false while live /
      reconnecting / idle.

If the control just calls into the connector with no branching logic worth a unit:
"n/a — this task only wires a UI control to t040's existing `connect` entry point;
no new pure logic."

### Layer 2 — Manual smoke (CDP/IPC)

HITL — needs a live Remote Browser via `pnpm web` (ideally through the deployment
to exercise the real proxy chain where idle-socket reaps happen).

- [ ] Connect to the Host; confirm the Active Tab renders frames and accepts input.
- [ ] **Kill the Host and leave it down past t040's max-attempts ceiling** so
      auto-reconnect gives up and the status bar shows the terminal "Disconnected"
      state with the Reconnect affordance.
- [ ] **Restart the Host, then tap Reconnect** (status bar) → the page recovers —
      frames resume, input works, Adaptive Viewport metrics re-applied if enabled —
      with no reload. Repeat via the **settings-drawer Reconnect** button → same
      recovery.
- [ ] **Tap Reconnect repeatedly while a reconnect is in flight** (mash it during the
      backoff window): no double socket — the `connectId` guard holds; exactly one
      live screencast in CDP `/json` after it settles, no duplicate listeners.
- [ ] **Tap Reconnect while auto-reconnect is mid-backoff** (Host still down): it
      cancels the pending backoff timer and starts a fresh connect immediately, and
      the backoff schedule restarts from the base delay (verify in server logs /
      network panel — the cadence resets, it doesn't resume mid-schedule).
- [ ] Confirm a healthy, connected session shows **no** prominent Reconnect
      affordance in the status bar and that the settings-drawer button never causes a
      disconnect.

### Layer 3 — Visual review

- [ ] Screenshots via Chrome DevTools against `pnpm web` running locally (desktop web
      is acceptable for the status-bar / settings states).
- [ ] All four states visible: **live** (no Reconnect affordance in the bar),
      **reconnecting** (t040's spinner, no Reconnect-clutter), **terminal
      Disconnected** (Reconnect affordance + Connection settings), and the
      **settings-drawer Connection card** showing its Reconnect button.
- [ ] The status-bar Reconnect affordance reads as an action (not error-red noise)
      and sits cleanly beside the existing Connection-settings link.
- [ ] iPad-physical confirmation (tap Reconnect on the installed PWA after a real
      drop, finger-sized target) is **HITL** — covered by the t018 gate and t048's
      hit-target rule.

## Design notes

The control is a thin UI affordance over t040's connector loop — it owns no retry
state. Its single job: cancel the pending backoff timer, reset the schedule, and
re-enter the **same** `connect` path the auto-loop uses, for the current Active Tab.
The `connectId` race-guard t040 reuses is what makes a manual tap idempotent for
free — a tap is just another `connect`, so a late-resolving prior attempt is already
discarded by the guard.

- **`remote-page-connector.js`** — already owns the single live socket, the
  `connectId` race-guard, and (after t040) the backoff loop bound to `onClose`. This
  task adds a small **`reconnectNow()`** verb to the connector surface (or exposes
  t040's existing force-connect path): it cancels any pending backoff timer, resets
  the backoff state to base (reusing `reconnect-backoff.ts`'s reset, **not** a second
  counter), and calls `connect({ tabId })` for the current tab through the existing
  guard. `connect`/`disconnect` semantics are otherwise unchanged. This is the one
  shared entry point t058's palette command will also call.
- **`src/lib/cdp-web-transport.ts`** — the web assembler exposes the `CdpBridge`
  surface. Add a `reconnect()` method to the bridge (Electron's preload may stub it;
  the UI guards with `?.`, like the transport-picker hooks) that drives the
  connector's `reconnectNow()` on the web path. The recovered socket re-feeds the one
  Downlink source and the Uplink command path with no second socket — same
  one-source guarantee t029 established. No change to `onDisconnected` / `onEvent`.
- **`src/components/status-bar.tsx`** — in the terminal-error branch (today the
  `isError` path showing the Connection-settings button), add a **Reconnect** button
  beside it. It reads as an action, not error-red noise. The bar stays hidden when
  idle, so the affordance only ever shows in the disconnected state — preserving the
  uncluttered live session. The bar gains an optional `onReconnect?` prop (mirroring
  `onOpenSettings`); no new status-derivation contract, just one more recognized
  affordance in the existing terminal branch.
- **`src/components/settings-dialog.tsx`** — in the **Connection** card, add a
  Reconnect button (a sibling of Test / Save). It calls the bridge's `reconnect()`.
  Connect-only — it never disconnects. Reuses t048's coarse-pointer hit-slop so the
  tap target clears 44pt on iPad.
- **`src/app.tsx`** — passes `onReconnect` to the status bar and the settings dialog,
  both calling `window.cdp.reconnect?.()` for the current Active Tab
  (`activeTabIdRef`). `app.tsx` does not own a retry loop — it just forwards the tap
  to the bridge.

- **Contracts changed:** `CdpBridge` gains an optional `reconnect()` method
  (UI-guarded with `?.`, like `reconfigureInputTransport`). The connector gains a
  `reconnectNow()` verb that reuses t040's backoff state + `connect` path; its
  `connect`/`disconnect` signatures are unchanged. `StatusBarProps` gains an optional
  `onReconnect`. No new pure module unless a `shouldOfferReconnect` predicate is
  warranted.
- **New modules:** none (a one-line predicate, if extracted, lands in an existing lib
  module — not a new file).
- **New ADR needed?** No. This is the manual lever on the self-healing loop t040
  already homed in the connector; it adds no new architectural decision. If the
  manual-vs-auto interplay surfaces a policy worth recording, append an addendum to
  the connector's ADR rather than opening a new one.

```ts
// the shared force-reconnect entry point — manual tap and (later) the ⌘K command
// both call it; it reuses t040's backoff state + connectId guard, never a 2nd loop
interface RemotePageConnector {
  // …existing connect / disconnect …
  reconnectNow(): void // cancel pending backoff timer, reset schedule to base,
  //                      connect({ tabId: current }) through the existing guard
}

// CdpBridge (web) — UI guards with ?. since Electron's preload may stub it
interface CdpBridge {
  // …
  reconnect?(): void
}
```

## Out of scope

- The **auto-reconnect loop itself** — that is **t040** (this task's dependency).
  This task adds the manual lever into t040's loop; it does not implement the loop,
  the backoff schedule, or the real-drop detection.
- The **⌘K command-palette "Reconnect" entry** — that is **t058** (`command-palette-cmdk`,
  outer ring). It will register a command pointing at the same `reconnect()` entry
  point this task lands, but the palette wiring is not built here.
- The **foregrounded WS re-climb on a timer** — that is **t041**; both compose with
  t040's backoff state, neither duplicates the counter.
- The **latency HUD / metrics surfacing** (t059, outer ring) — unrelated.
- Re-deriving the **44pt coarse-pointer hit-target rule** — that lives in **t048**;
  this task reuses its pattern, it does not own it.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (only if a `shouldOfferReconnect` predicate was
      extracted; otherwise n/a — no new pure logic)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser via `pnpm web`
      (tap Reconnect after the ceiling → recover; mash it mid-flight → no double
      socket; tap mid-backoff → schedule resets to base)
- [ ] Layer 3 screenshots captured and committed (status-bar Reconnect in terminal
      Disconnected; settings-drawer Reconnect; live state shows no clutter)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm web` boots cleanly and the page recovers end-to-end on a manual Reconnect
      after a real drop
- [ ] CLAUDE.md updated for any modified module (the connector's `reconnectNow()`
      verb; the bridge's `reconnect()` method; `src/lib/CLAUDE.md` if a predicate lands)
- [ ] ADR written if an architectural decision was made (expected: none — addendum to
      the connector ADR only if the manual/auto interplay warrants it)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t042 in commit

## Notes

- Hard precondition: **t040 must land first.** This control has nothing to call into
  until the connector owns the backoff loop and the `connect` force-entry path. Build
  it on top of t040's state, never a parallel retry counter.
- Idempotence is **free** if the retry flows through t040's `connectId` guard: a
  manual tap is just another `connect`, so the guard discards a late-resolving prior
  attempt exactly as it does for an auto-retry that overlaps a Tab switch. Do not add
  a separate debounce timer — route through the guard, not around it.
- A manual Reconnect **resets** the backoff schedule to its base delay (it's a fresh
  user intent, not a continuation), and **cancels** any pending backoff timer so the
  immediate connect doesn't race a queued auto-retry back to life. This mirrors
  t040's `disconnect()`-cancels-the-timer discipline.
- "Reconnect" is an **action affordance**, not an error message — it sits beside the
  Connection-settings link in the terminal state, styled as a button to tap, not
  red error text.
- Keep the live session uncluttered: the status bar is already hidden when idle, so
  the affordance naturally only appears in the disconnected/terminal state. Don't add
  a persistent Reconnect chrome that shows during a healthy session.

---

_When task status flips to `done`, move this file to `done/`._
