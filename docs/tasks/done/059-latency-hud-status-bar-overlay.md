# 059 — toggleable latency HUD in the status bar, off by default

- **Status:** done
- **Mode:** HITL
- **Slice:** 4-table-stakes-latency
- **Ring:** outer
- **Estimate:** 0.5d
- **Depends on:** latency-metrics-rtt-ping-and-frame-age (t057)
- **Blocks:** none

## Goal

Surface the always-on latency metrics — round-trip time, jitter, screencast frame age, and the active transport — in a small status-bar HUD that the user can turn on. Today the link can silently demote (WS → SSE+POST, streaming-input → batched fallback) or just get laggy, and nothing on screen says so; the user only feels mush. After this task, a HUD toggle (off by default) renders t057's live numbers in the bottom status bar, so when the fast path silently drops the user can *see* it — RTT climbing, frame age growing, transport reading `SSE` instead of `WS`. It is display-only: it reads the metrics t057 already collects and adds no measurement of its own.

## Why now

Decision 4 of the locked v0.1.0 scope splits latency into cheap wins + always-on metrics now, codec work deferred to a data-driven v0.2 call. The metrics (t057) are collected unconditionally; this HUD is the human-readable window onto them. It is the **outer ring** — fast-follow v0.1.1, *not* tag-blocking for v0.1.0 — so it ships right after the inner-ring latency work but does not hold the tag. Keeping it off by default means zero cost to the default daily-driver experience; the value is diagnostic, for the moment the iPad feels slow and the user wants to know whether it's the network, the proxy, or the remote.

## Acceptance criteria

- [ ] The HUD is **off by default** — a fresh load shows no latency readout in the status bar.
- [ ] A toggle exists to turn the HUD on, reachable from settings (a switch row in `settings-dialog.tsx`); its state persists across reloads (web `localStorage` ui-state, same channel as the other web-only toggles).
- [ ] When on, the status bar shows, at minimum: **RTT** (ms), **jitter** (ms), **frame age** (ms), and the **active transport** label (e.g. `WS` / `SSE` / `Stream` / `Batch`).
- [ ] The values update live from t057's metrics as new pings / frames arrive (no manual refresh).
- [ ] The HUD reads existing metrics only — it issues no extra pings, frames, or network calls of its own.
- [ ] When metrics are not yet available (no ping returned / no frame painted yet), the HUD renders a neutral placeholder (e.g. `—`) rather than `NaN`/`undefined`.
- [ ] The HUD coexists with the existing transient status-bar content (connecting / error rows) without overlapping or pushing layout — it occupies its own slot and stays out of the way when an error row is showing.
- [ ] No change to the default status bar when the toggle is off (no extra DOM, no layout shift).
- [ ] Electron build unaffected: the toggle is web-only (it reads web-transport metrics); on Electron it is hidden or inert, consistent with the other web-only settings.

## Test plan

### Layer 1 — Pure logic (TDD)

The only pure logic is value formatting — extract it so the React component stays dumb.

- [ ] `formatLatencyHud(metrics)` (a small pure formatter, e.g. in `status-bar.tsx` or a co-located `lib` helper) — given a metrics snapshot returns the display strings:
  - [ ] rounds RTT / jitter / frame age to whole ms with a unit suffix
  - [ ] maps the transport enum to its short label (`WS` / `SSE` / `Stream` / `Batch`)
  - [ ] returns the neutral placeholder (`—`) for `undefined` / `null` / `NaN` inputs (metrics-not-ready case)
- [ ] If the formatter is trivial enough to live inline and t057 already exposes display-ready strings, this is "n/a — display over t057 data; no new pure logic." Prefer a tested formatter if any rounding/placeholder logic exists.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process, IPC, or web-server code touched. The HUD is renderer display-only over metrics t057 already pushes.

### Layer 3 — Visual review

- [ ] Desktop-web via Chrome MCP against `pnpm dev` (or built `dist/` through `pnpm web`): with the toggle **off**, the status bar shows no latency readout (default state).
- [ ] Toggle the HUD **on** in settings → the status bar shows live RTT / jitter / frame-age / transport; values change as pings/frames arrive. Screenshot captured.
- [ ] Force a transport demotion if reachable (e.g. block WS so it falls back to SSE) and confirm the transport label flips accordingly — confirms the "see the silent demotion" goal. If not reproducible on desktop, flag as HITL for t018.
- [ ] Error state: trigger a connection error and confirm the HUD does not overlap or fight the red error row.
- [ ] iPad-physical (HITL, flagged for t018): toggle on in the installed PWA, confirm the readout is legible at iPad density and fits the safe-area bottom inset without clipping.

## Design notes

Behavioral change, not a path walk:

- **`src/components/status-bar.tsx`** — gains an optional latency-HUD slot rendered only when the toggle is on. It takes the current metrics snapshot (and the on/off flag) as props and renders the formatted RTT / jitter / frame-age / transport. It must not disturb the existing connecting / error / idle rows — the HUD is its own region (e.g. a right-aligned group), shown alongside or in place of the idle row, never covering an error.
- **`src/components/settings-dialog.tsx`** — gains a web-only switch row ("Latency HUD" or similar) in the appropriate grouped card, wired to a persisted ui-state flag, matching the existing web-only toggle pattern (the connection-mode picker / push toggle live there). Hidden / inert on Electron via the same `window.webCaps` gating the other web-only rows use.
- **`src/app.tsx`** — threads the HUD-enabled flag and the live metrics snapshot from t057 down to `StatusBar` as props. The metrics source is t057's estimator (RTT/jitter ping + server frame-age timestamp, built on `src/lib/perf-mark.ts`); this task assumes t057 exposes a read-friendly snapshot (numbers + active-transport label). If t057's shape differs at integration time, adapt the props here — do not re-measure.

- **Contracts changed:** none structural. New prop(s) on `StatusBarProps` (HUD flag + metrics snapshot) and one new persisted ui-state boolean (HUD on/off).
- **New modules:** at most a tiny pure `formatLatencyHud` formatter (co-located or a small `lib` helper) if rounding/placeholder logic warrants a Layer-1 test; otherwise none.
- **New ADR needed?** no — this is display polish over the metrics decided in t057 / Decision 4 of the locked v0.1.0 plan. No new architectural decision.

```ts
// assumed shape consumed from t057 (adapt at integration if it differs):
type LatencyMetrics = {
  rttMs?: number
  jitterMs?: number
  frameAgeMs?: number
  transport: "ws" | "sse" | "stream" | "batch"
}
// this task: format + render, gated by a persisted boolean. No measurement.
```

## Out of scope

- The metrics collection itself — RTT/jitter ping estimator + server frame-age timestamp are **t057**; this task only displays them.
- The Cmd+K palette toggle entry for the HUD — palette is **t058** (also outer ring). If t058 lands, it can register a "Toggle latency HUD" command against the same persisted flag; this task does not build the palette and only needs the settings toggle.
- Latency *codec* work (WebRTC / WebCodecs) — deferred to v0.2 (Decision 4, data-driven call).
- The quality-latency tier picker (Sharp/Balanced/Snappy) — separate task **t055**.
- Any always-on / non-toggleable HUD, alerting, or thresholds-with-color logic — v0.1.0 is a plain toggleable readout, off by default; smart "you're degraded" affordances are a later idea.
- Electron version surfacing / Electron-specific transport metrics — Electron is best-effort, web-only toggle here.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if a `formatLatencyHud` formatter was added)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched) — n/a here
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module (note the optional status-bar latency HUD + its web-only toggle, if it adds clarity)
- [ ] ADR written if an architectural decision was made (expected: none)
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t059 in commit

## Notes

- Depends on t057's metrics snapshot. If t057 isn't merged yet, the formatter + toggle + settings row can land first against a stub snapshot, then be wired to the real source — but verify the live wiring before closing.
- Keep it cheap: the HUD must add zero work when off (gate the whole slot on the flag, render nothing) so the default daily-driver path is untouched.
- This is the **outer ring** — do not let it block the v0.1.0 tag. If it slips, it ships in v0.1.1.

---

_When task status flips to `done`, move this file to `done/`._
