# 039 — stop spurious disconnected broadcast on every tab switch (web + main)

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 1-never-stuck
- **Category:** bug
- **Effort:** S
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** 040-bounded-backoff-auto-reconnect-on-real-drop

## Goal

Switching tabs must not announce a disconnect. Today every tab switch tears down the old Remote Page socket and opens a new one, and the old socket's `close` fires an unconditional `disconnected` broadcast — so the status bar flashes "Disconnected" on every switch and the drop signal that auto-reconnect will key off is indistinguishable from a routine switch. After this task, an **intentional/host-initiated** teardown (switch, manual disconnect) is silent, and only a **real** socket drop (link died, CDP host gone) broadcasts `disconnected`. Fixed in both backends: `remote-page-connector.js` (web, the priority surface) and the inline copy in `main.js` (Electron, per decision 7).

## Why now

This is on the v0.1.0 never-stuck slice and it is a hard prerequisite for the auto-reconnect work (t040). Auto-reconnect listens for a `disconnected` event and reconnects on it; if every tab switch also emits `disconnected`, auto-reconnect either fires spuriously on switches or has to be made switch-aware downstream. Cleaning the signal at the source means the drop event means exactly one thing. It also kills a visible daily-driver jiggle: the status bar flashing "Disconnected → Connected" on every tab tap on the iPad PWA reads as flakiness.

## Acceptance criteria

- [ ] An intentional switch teardown (a new `connect` while a socket is live) does **not** emit a drop/`disconnected` event in `remote-page-connector.js` — the old socket is detached before it is closed, exactly as `disconnect()` already does.
- [ ] `disconnect()` (host-initiated) stays silent — no regression to its existing detach-before-close behavior.
- [ ] A **real** drop (the active socket's `close` fires without a host-initiated teardown having detached it) still emits `disconnected` through `onClose` → the host broadcast.
- [ ] The same distinction holds in the `main.js` inline connect copy: the switch-teardown close of the previous `activeWs` does not `chromeSend("cdp:disconnected")`; a genuine drop of the active socket still does.
- [ ] Behavior is identical across both backends — the web `broadcast("disconnected", {})` and the Electron `chromeSend("cdp:disconnected")` fire on real drops only, never on switches.
- [ ] No change to the renderer contract: the renderer still receives one `disconnected` per real drop and `Connected` on first frame; the status bar settles to "Connected" after a switch with no "Disconnected" flash in between.

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md). The connector is a repo-root CJS core → strict TDD (Layer 1). The `main.js` inline copy is CDP/WS glue with no pure seam → manual smoke (Layer 2). No renderer UI changes → Layer 3 is the existing status bar, observed only.

### Layer 1 — Pure logic (TDD)

Extend `remote-page-connector.test.ts` against the existing fake transport:

- [ ] connector — a second `connect` while one is live closes the prior socket **without** emitting `onClose`/`disconnected` (switch teardown is silent; assert the close-callback fired zero times for the superseded socket).
- [ ] connector — `disconnect()` closes the active socket silently (no `onClose` fires) — pin the existing behavior so the fix doesn't regress it.
- [ ] connector — a **real** drop: the active socket's underlying `close` fires on its own (not via a host-initiated teardown) and `onClose` fires exactly once → `disconnected` reaches the host.
- [ ] connector — after a switch (old socket superseded, new socket live), a later real drop of the **new** socket still emits exactly one `disconnected` (the superseded socket can never resurface a stale drop).

### Layer 2 — Manual smoke (CDP/IPC)

Needs a live Remote Browser. HITL.

- [ ] `pnpm web` against a reachable CDP Host: switch tabs rapidly back and forth several times — the status bar never shows "Disconnected"; it settles on "Connected" each time.
- [ ] `pnpm dev` (Electron): repeat the rapid-switch check — no "Disconnected" flash in the status bar on switch.
- [ ] Real drop still reported (web): kill/restart the CDP Host mid-session — the status bar **does** show "Disconnected" (the genuine drop is not swallowed).
- [ ] Real drop still reported (Electron): same kill/restart check under `pnpm dev` — "Disconnected" appears.

### Layer 3 — Visual review

- [ ] n/a — no renderer UI or layout changes. The status bar text is unchanged; only the spurious transition is removed. Observed indirectly via the Layer 2 smoke (no "Disconnected" flash on switch).

## Design notes

The connector already has the right primitive: `disconnect()` calls `old.__detach()` before `old.close()` so the host never hears the close it triggered. The bug is that the **switch-teardown** path inside `connect` does not — it goes through `teardown(old)`, which closes the socket but leaves `onClose` attached, so the close fires `emitClose()` → `broadcast("disconnected", {})`. `main.js` has the identical inline shape: the `if (activeWs) { … old.close() }` block at the top of the connect handler closes the previous socket with its `ws.on("close", …)` still attached, and that handler calls `chromeSend("cdp:disconnected")`.

The fix is to make **host-initiated** teardown detach-before-close everywhere, so only a close the host did **not** initiate (a genuine drop) reaches the host. The distinction is "did we tear this socket down on purpose?" — if yes, detach first; if the close arrives on its own, it's real.

- **Contracts changed:** none at the type level. `onClose`/`onEvent` and the `cdp:disconnected` / `broadcast("disconnected")` signals are unchanged; their **firing condition** narrows from "any close of the active or just-superseded socket" to "a close the host did not initiate" (a real drop). The renderer's `disconnected` event shape is untouched.
- **Files touched:**
  - `remote-page-connector.js` — make the switch-teardown path detach the superseded socket before closing it (reuse the existing `__detach` mechanism that `disconnect()` already uses). The race-guard `connectId` invariant (ADR-0001/ADR-0002) is preserved unchanged — this only stops the superseded socket's close from reaching the host.
  - `main.js` — apply the same detach-before-close to the inline previous-`activeWs` teardown at the top of the connect handler so the superseded socket's `close` handler does not `chromeSend("cdp:disconnected")`. main.js stays CJS, inline (no connector adoption — see Out of scope).
- **New modules:** none.
- **New ADR needed?** no — covered by ADR-0001 (single Remote Page) and ADR-0008 (shared CJS core); this only sharpens an existing event's firing condition. No new architectural decision.

## Out of scope

- The t032 connector-adoption refactor for `main.js` — deferred to v0.2 (decision 7). This task fixes the inline copy in place; it does **not** make `main.js` consume `remote-page-connector.js`. Do not touch task 032.
- Adding the actual auto-reconnect / bounded-backoff behavior — that is t040, which this unblocks. This task only cleans the drop signal it will consume.
- Timer-based WS reconnect while foregrounded (t041) and one-tap manual reconnect (t042) — separate never-stuck tasks.
- Any change to the renderer's `disconnected` handling, status-bar copy, or the viewport poll gating — the signal is cleaned at the source; downstream consumers are unchanged.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (connector switch-teardown silence + real-drop still fires)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (web + Electron: no flash on switch, real drop still reported)
- [ ] Layer 3 — n/a (no UI change)
- [ ] `pnpm check` clean (Biome — lint + format; verify the touched files)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` and `pnpm web` boot cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated if the Remote Page connect/disconnect description needs it (the disconnected-on-switch behavior was implicit; note the corrected firing condition if it adds clarity)
- [ ] ADR — none needed
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t039 in branch + commit

## Notes

- The load-bearing primitive already exists: `disconnect()` in `remote-page-connector.js` detaches via `ws.__detach()` before `ws.close()` so the host never hears a host-initiated close. The switch-teardown path (`teardown(old)`) just needs the same treatment.
- Verify the equivalence both ways: switch → silent; pull the plug → still loud. A fix that silences switches but also swallows real drops is worse than the bug, because t040 would then never fire.
- main.js carries the bug as an inline duplicate (no connector yet). Patch it in place; the eventual connector adoption (t032, v0.2) will delete the duplicate entirely.

---

_When task status flips to `done`, move this file to `done/`._
