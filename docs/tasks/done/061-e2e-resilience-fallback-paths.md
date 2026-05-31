# 061 — hermetic e2e: transport fallback + reconnect resilience

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Slice:** 5-acceptance
- **Ring:** inner
- **Effort:** L
- **Risk:** medium
- **Depends on:** fix-spurious-disconnect-on-switch (t039), auto-reconnect-on-real-drop (t040), ws-auto-reconnect-while-visible (t041)
- **Blocks:** ipad-workday-gate (t018/062)

## Goal

The never-stuck chain is the load-bearing promise of v0.1.0, and right now it is only proven by hand on the iPad. After this task it is proven by an automated end-to-end suite that runs in CI against a **hermetic fake CDP host** (a Node WS/HTTP stub, not a live browser), so a regression in the fallback or reconnect paths goes red on a PR instead of stranding the user mid-morning. The suite drives the real `web/server.mjs` against the fake host and asserts the four resilience guarantees end-to-end: (1) the transport **falls back WS → SSE+POST** when WS is unreachable and still streams Screencast Frames and still forwards input to the host; (2) a **real drop** mid-session triggers t040's bounded-backoff auto-reconnect and the session self-heals when the host returns, with no duplicate live socket; (3) the foregrounded **WS re-climb** (t041) recovers the fast path after a blip; (4) a **normal tab switch** does **not** emit a user-visible disconnect (t039 regression guard). This is the automated half of the acceptance gate; t018 is the human iPad half.

## Why now

This is the **5-acceptance** slice — it closes the loop on the never-stuck slice (t039–t041) by making those guarantees regression-proof rather than one-time-verified. The dependencies have each shipped their own pure-logic tests (backoff schedule, `shouldReconnect` predicate, the disconnect-signal fix), but nothing exercises the *whole chain* through the real server: a transport that falls back, drops, and re-climbs across socket boundaries. Those are exactly the seams a future refactor (the t032 connector adoption into `main.js`, a transport-selector tweak, a server route change) can silently break, and the failure mode is the worst one for a daily driver — a frozen last frame the user has to notice and reload. Wiring this into the hermetic `pnpm test:e2e` suite that the **t037 CI gate** already runs means the never-stuck contract is enforced on every PR before it can reach the m4-pro-mbp prod target. It must land before the **t018/062 iPad workday gate** so the human pass is confirming polish, not catching a transport regression the machine should have caught.

## Acceptance criteria

- [ ] **Fixture reuse, extended for resilience.** The hermetic fake CDP host (`test/e2e/fake-cdp-host.mjs`) and the server harness (`test/e2e/server-harness.mjs`) are **reused** — not reinvented. The fixture gains the small hooks the resilience specs need that it does not already have: simulate a **mid-session host drop** (close the live target sockets and/or stop accepting, so the server's Remote Page socket sees a real `close`) and a **host return** (resume accepting + serve `/json` again) **without losing the recorded inputs/activations** the harness asserts on. Any new hook is a thin, documented method on the returned handle (e.g. `dropConnections()` / a `stop()`-then-restart on the **same port**), mirroring the existing `setTargets`/`fireNotification` style.
- [ ] **Fallback path — WS → SSE+POST.** A spec asserts that with WS reachable, a Screencast Frame arrives end-to-end over WS after connect; and that with WS **disabled/blocked** (the upgrade refused, or the client steered off WS), the client falls back to **SSE+POST** and **still** (a) receives a Screencast Frame over SSE and (b) lands an `Input.dispatch*` command on the fake host via the POST/batch path. Both transports are asserted in the same suite so the fallback is a real switch, not two independent happy paths.
- [ ] **Real-drop auto-reconnect.** A spec connects, confirms frames flow, then **drops the host mid-session**; it asserts the server's Remote Page enters the reconnect loop (t040's bounded backoff — retry attempts observed on a growing-then-capped cadence, not a tight storm), then **returns the host** and asserts the session **self-heals**: frames resume and a fresh `Input.dispatch*` reaches the host again — **with no duplicate live socket** (exactly one screencast attachment on the recovered target; no doubled `onEvent` delivery).
- [ ] **WS re-climb after a blip.** A spec (WS active) drops only the WS path mid-session while the session is otherwise reachable, and asserts the client **re-climbs to WS** (t041) — frames + input return on the WS path — without a reload and without leaking a second socket. (If the hermetic harness cannot isolate a WS-only blip from a full host drop, this is asserted at the seam level via the t041 `shouldReconnect` composition driving a re-attempt through the real server; note the chosen approach in the spec.)
- [ ] **Tab-switch is not a disconnect (t039 guard).** A spec connects to one tab, switches to another, and asserts **no** user-visible `disconnected` event is emitted across the switch (the SSE/WS `disconnected` push does not fire on an intentional switch) — only a real drop does. This is the regression guard that keeps auto-reconnect from thrashing on normal use.
- [ ] **Runs headless in CI, in the hermetic suite.** The new specs live under `test/e2e/` as `*.e2e.test.ts`, run in the **node env** (no browser), and are picked up by `pnpm test:e2e` (`vitest.e2e.config.ts`) — the exact suite the **t037** CI gate runs. They are **not** added to the fast `pnpm test` run (still excluded by `vite.config.ts`), and they do **not** require a real browser, a real CDP host, or any secret.
- [ ] **Deterministic — no flake from real wall-clock waits.** The specs do not `sleep` arbitrary durations to "hope" a reconnect happened: they **poll a predicate** (the existing `waitFor` helper) or drive the pure backoff seam with an **injected clock / shortened backoff config** so the retry cadence is bounded and observable in test time. Where the server's backoff timing must be shortened for the test, it is done via an **injected/env-configurable** knob, not by editing production defaults. The suite passes repeatably (no time-dependent assertion that races the server's own timers).

## Test plan

Per [../conventions/tdd.md](../conventions/tdd.md): the pure pieces these specs lean on — the backoff schedule (`reconnect-backoff.ts`, t040) and the transport-selection / `shouldReconnect` machine (`transport-selector.ts`, t019/t041) — are **already unit-tested by their own tasks**; this task does **not** re-test them. This task **is** the automated Layer-2 end-to-end for the resilience chain; it replaces the manual smoke for these paths. A final live-host smoke is still worth one pass (covered by the t018 gate), but is not a gate for this task.

### Layer 1 — Pure logic (TDD)

- [ ] If a new **fixture helper** with non-trivial logic is added (e.g. a drop/restart-on-same-port coordinator, or an injected-clock backoff shim used to make the cadence deterministic), add focused unit coverage for that helper. Otherwise: n/a — this task adds e2e wiring, not new domain logic; the backoff and selector machines are owned and tested by t040/t041.

### Layer 2 — Hermetic e2e (this IS the automated half)

These are the deliverable. Each spec spawns the real `web/server.mjs` against the fake CDP host and asserts over HTTP/SSE/WS in a node env (no browser), polling predicates rather than sleeping.

- [ ] **Fallback:** WS reachable → a `Page.screencastFrame` arrives over WS after `/api/connect`. WS blocked/steered-off → a `Page.screencastFrame` arrives over **SSE**, AND a posted `Input.dispatchMouseEvent` (or key event) is recorded by the fake host via the **POST/batch** path. (Builds on the existing "screencast frame over SSE" + "cdp-batch forwards mouse events" specs — the new assertion is that the fallback fires when WS is unavailable.)
- [ ] **Auto-reconnect:** connect → frames flow → **drop the host** → the server's Remote Page reconnect loop is observed (retry attempts on a growing-then-capped cadence; a `disconnected` push fires for the *real* drop) → **return the host** → frames resume and a fresh input lands on the host. Assert **exactly one** live screencast attachment on the recovered target (no duplicate socket, no doubled frame delivery).
- [ ] **WS re-climb:** WS active → WS path blips → the client re-attempts and **returns to WS** (frames + input on WS), one socket after recovery. (Or, if a WS-only blip can't be isolated hermetically, drive the t041 re-climb composition through the real server and assert the WS path is restored — document the approach.)
- [ ] **t039 guard:** connect to tab A → switch to tab B → assert **no** `disconnected` event is delivered to the client across the switch (only a real drop emits it). Pair with the auto-reconnect spec so "switch = silent, real drop = `disconnected`" is asserted as one contrast.

### Layer 3 — Visual review

n/a — no renderer UI is touched. The browser-layer Playwright spec (`test:e2e:browser`) already covers the UI flows; this task is the node-env hermetic suite, not a UI change.

## Design notes

The work is **test + fixture**, not application code: the four guarantees already live in t039–t041's production modules; this task proves them through the real server. The discipline is the project's existing e2e shape — spawn `web/server.mjs` against the in-process fake host, assert over the wire, poll predicates, never sleep on a guess.

- **`test/e2e/fake-cdp-host.mjs`** *(extended)* — the fixture already speaks the `/json` + screencast + Input subset and records `activations` / `inputs` per target. It gains the resilience hooks: a way to **drop** the live target WS connections mid-session (so the server's Remote Page socket sees a genuine `close`, the real-drop signal t039/t040 key off) and a way to **come back** (resume serving `/json` and accept new upgrades) — ideally a restart on the **same port** so the server's reconnect loop, which re-hits the same `CDP_HOST:CDP_PORT`, finds the host again. Recorded inputs/activations must survive a drop where the spec asserts across it (or the spec clears + re-asserts deliberately, matching the existing `clearInputs()` pattern). Keep the hooks thin and named like the existing handle methods.
- **`test/e2e/server-harness.mjs`** *(possibly extended)* — already spawns `web/server.mjs` with `CDP_HOST`/`CDP_PORT`/`PORT` env and exposes `fetch`/`post`/`collectSse`/`openWs`/`wsReady`. If the server's reconnect cadence needs to be **shortened for deterministic tests**, thread a backoff-config env knob through `extraEnv` (the harness already forwards `extraEnv` — the E2E-crypto suite uses it for `E2E_ITERS`). No new transport; reuse the SSE collector and WS helpers for the frame/input assertions.
- **`test/e2e/resilience.e2e.test.ts`** *(new spec file, or new `describe` blocks added to `server.e2e.test.ts`)* — the four `describe`s (fallback, auto-reconnect, WS re-climb, t039 guard). Reuses `startFakeCdpHost`/`startWebServer`/`waitFor`/`connectAndWait` verbatim. The WS-blocked condition is produced the way the harness already allows (don't open `/api/ws`, or steer the client to SSE+POST) so the fallback assertion is a real switch, not a parallel path.
- **Determinism seam:** the cadence is made observable in test time by **either** shortening the server's backoff via an injected config (env knob) **or** asserting the *fact* of retry + recovery (frames resume) rather than the exact timing. The pure backoff schedule itself is already unit-tested (t040) — these specs assert the *wired* behavior, so they should not re-pin the precise delay sequence; they assert "retries happen on a bounded cadence, then recovery," polled, not slept.

- **Contracts changed:** none. No application module, no `CdpBridge` surface, no server route changes. New/extended test fixtures and spec files only. (If a backoff-shortening env knob is added to `web/server.mjs`, it is a test-only config read with the production default unchanged — note it, but it is not a contract change.)
- **New modules:** none in `src/lib/`. New test file `test/e2e/resilience.e2e.test.ts` (or new `describe`s in the existing e2e spec); thin new methods on the fake-host handle.
- **New ADR needed?** No. This realizes the acceptance half of the never-stuck slice that ADR-0006/0007 (web proxy SSE + WS transport) and the t040/t041 reconnect work already sanction; it adds no new decision, only the automated proof. If the fixture's drop/restart mechanism turns out to warrant a recorded pattern, note it in `test/e2e/README.md`, not an ADR.

```ts
// new fixture hooks on the fake-host handle (shape, not path)
interface FakeCdpHost {
  // …existing: getActivations, getInputs, clearInputs, fireNotification, setTargets, getLiveTargets, stop
  dropConnections(): void   // close live target WS so the server sees a real drop
  // host "return": restart accepting on the same port (a stop()/start pair, or a paused→resumed flag)
}
```

## Out of scope

- The **iPad on-device workday** — that is **t018/062**, the human half of the acceptance gate. This task is the machine half; it does not touch real hardware, real networks, or a real browser.
- **Live-proxy verification** (the outer-ring t060 against portal.dustin.one / the real nginx+Authentik chain) — those exercise the real link RTT and idle-socket reaps; this task is hermetic-only and must not depend on any remote host or secret.
- The **crypto-verifier-reject e2e** (a wrong-passphrase handshake rejection assertion) — **deferred to v0.2**; the E2E-crypto suite already covers the happy path here.
- The **Playwright browser-loop** resilience flows (driving the fallback/reconnect through headless Chromium UI) — **deferred to v0.2**; this task is the node-env hermetic suite, the cheaper and faster gate. The existing `test:e2e:browser` UI specs are unchanged.
- Any change to the **production** reconnect/fallback behavior — t039/t040/t041 own that; this task only proves it. The single permitted production touch is a **test-only** backoff-shortening env knob with the default unchanged, and only if needed for determinism.
- Adopting the connector into **`main.js`** (t032, deferred v0.2) — these specs run the web/server path that already consumes the shared core.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (only if a non-trivial new fixture helper was added; otherwise n/a)
- [ ] Layer 2 hermetic e2e specs written and green: fallback (WS → SSE+POST, frame + input), auto-reconnect (drop → backoff → recover, one socket), WS re-climb after a blip, t039 switch-is-silent guard
- [ ] Layer 3 screenshots — n/a (no UI touched)
- [ ] `pnpm test:e2e` runs the new specs headless and green, repeatably (run it ≥3× locally to confirm no flake)
- [ ] `pnpm check` clean (Biome — lint + format) on the files this task touches (not pristine)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green (fast unit run — the e2e specs stay excluded from it)
- [ ] `pnpm web` still boots cleanly (no production behavior changed; if a test-only env knob was added, confirm the default path is unaffected)
- [ ] CLAUDE.md / `test/e2e/README.md` updated: the new resilience specs and any new fake-host hooks are described where the e2e suite is documented
- [ ] ADR written if an architectural decision was made — expected: none (note the fixture drop/restart mechanism in `test/e2e/README.md` if it warrants it)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t061 in commit

## Notes

- **Hard precondition: t039 + t040 + t041 must land first.** This task proves their combined behavior; it cannot pass until the real-drop signal is clean (t039), the backoff loop recovers (t040), and the WS re-climb restores the fast path (t041). If any dependency is incomplete, the corresponding `describe` is the failing red bar — that is the suite working as intended, not a bug in this task.
- **Reuse, don't reinvent.** The fixture (`fake-cdp-host.mjs`) and harness (`server-harness.mjs`) are already mature — they back the existing connect/screencast/input/notifications/WS/crypto e2e suites. Extend them with the minimum new hooks; do not fork a second fake host.
- **No real timers in the assertion path.** The classic flake here is sleeping "long enough" for a reconnect. Poll a predicate (`waitFor`) or shorten the server's backoff via an injected config so the cadence is bounded and observable in test time. Do not assert the exact delay sequence (that is t040's unit test); assert *retry-then-recover*, polled.
- **One socket after recovery is the load-bearing assertion.** A leaked second live socket (a stale reconnect promoting over the recovered one) is exactly the bug class t040's `connectId` race-guard kills — assert exactly one live screencast attachment / no doubled frame delivery after the host returns, or the test does not actually prove the never-stuck guarantee.
- This is the gate that lets the **t018/062** human iPad pass be about feel ("I'd want to use this all day"), not about catching a transport regression a machine should have caught. Land it before that pass.

---

_When task status flips to `done`, move this file to `done/`._
