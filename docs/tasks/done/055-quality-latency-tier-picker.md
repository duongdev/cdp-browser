# 055 — Sharp/Balanced/Snappy quality-latency tier picker

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 4-table-stakes-latency
- **Estimate:** 1d
- **Depends on:** 054
- **Blocks:** none

## Goal

Add a three-way **Sharp / Balanced / Snappy** preset in Settings that trades screencast
sharpness for responsiveness in one tap. Each tier maps to a fixed
`{ jpegQuality, everyNthFrame }` pair; the choice persists web-only (like the transport
picker) and is applied on the next (re)connect, so the operator can dial the picture down
to a slow link without touching any other control. After this task the #1 stated latency
lever — "I'll take a softer image if it means the cursor keeps up" — is a single visible
toggle instead of a hardcoded `quality: 80`.

## Why now

This is an inner-ring **Slice 4 (table-stakes latency)** item — part of the v0.1.0 gate's
"cheap latency wins" that ship instead of the deferred codec work. The iPad PWA is the
daily driver over a real (sometimes slow) link; right now the only frame-rate lever is the
fixed `everyNthFrame` cap from t054, with no user control over the quality/rate trade. The
tier picker is the user-facing front-end of that cap: t054 stops stale frames piling up;
t055 lets the operator pick where on the sharp↔snappy curve they sit. It depends on t054
because both write the same `startScreencast` params and `everyNthFrame` must already exist
as a tunable before a tier can set it.

## Acceptance criteria

- [ ] A pure `qualityTier` module exposes the three tiers and a
      `tierToParams(tier) → { jpegQuality, everyNthFrame }` mapping, with a defined
      **default tier** (`balanced`) used when the stored value is missing/invalid.
- [ ] Tiers are ordered Sharp → Balanced → Snappy by **descending `jpegQuality`** and
      **ascending `everyNthFrame`** (sharper = higher quality + every frame; snappier =
      lower quality + skips frames). Exact numbers live in the module and are asserted by
      the tests, not scattered across the codebase.
- [ ] The picker renders in Settings (web only), persists the choice to `localStorage`
      under a stable key, and reads it back on mount — same persistence shape as the t019
      transport picker. It is **not shown** on the Electron build.
- [ ] Selecting a tier applies on the next (re)connect: `startScreencast` is sent with the
      tier's `jpegQuality`, and the screencast frame-rate cap uses the tier's
      `everyNthFrame`. No hardcoded `quality: 80` remains on the web path.
- [ ] Both `web/server.mjs` (via `remote-page-connector.js`) and the `main.js` inline
      `startScreencast` read the tier mapping rather than a literal, so the two paths can't
      drift. (Electron has no picker UI; it uses the default tier.)
- [ ] Switching tiers and reconnecting visibly changes the picture sharpness and frame
      cadence against a live link.
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` (touched files) green.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `quality-tier` `tierToParams` — each of `sharp` / `balanced` / `snappy` returns its
      exact `{ jpegQuality, everyNthFrame }`.
- [ ] `quality-tier` `tierToParams` — the mapping is monotonic: `jpegQuality` strictly
      decreases and `everyNthFrame` is non-decreasing across Sharp → Balanced → Snappy.
- [ ] `quality-tier` default — an absent or unrecognized stored value resolves to the
      default tier (`balanced`); a valid stored value round-trips.
- [ ] `quality-tier` persistence shape — the value parsed from / written to storage is one
      of the known tier ids (parse rejects garbage, falls back to default).

### Layer 2 — Manual smoke (CDP/IPC)

Needs a live Remote Browser (HITL):

- [ ] `pnpm web` against a live link, pick **Sharp**, reconnect → frames are visibly
      crisper; `startScreencast` carries the Sharp `quality`.
- [ ] Pick **Snappy**, reconnect → image is softer and the frame cadence is sparser
      (fewer frames/sec via the higher `everyNthFrame`); the cursor/interaction keeps up
      better on a throttled link.
- [ ] Reload the page → the last-picked tier is still selected (localStorage persisted).
- [ ] Electron build (`pnpm dev`) still screencasts with the default tier and shows no
      picker.

### Layer 3 — Visual review

- [ ] Screenshots captured via Chrome DevTools against `pnpm web`.
- [ ] The Sharp/Balanced/Snappy picker renders in Settings as a single 3-way control,
      grouped with the other latency/connection settings; selected state is clear.
- [ ] One screenshot per tier showing the rendered picker state (the three selections).

## Design notes

- **New module:** `src/lib/quality-tier.ts` — pure tier registry + `tierToParams` mapping
  + a `parseTier`/default helper. Single owner of the three `{ jpegQuality, everyNthFrame }`
  pairs so neither transport path nor the UI hardcodes numbers. Mirrors how
  `transport-selector.ts` owns the transport-mode state for the t019 picker.
- **Contracts changed:** `startScreencast` params on both connect paths read the tier's
  `jpegQuality` instead of the literal `80`, and the screencast frame-rate throttle (added
  in t054) reads the tier's `everyNthFrame`. The tier is read from web ui-state at
  connect time — `remote-page-connector.js` already takes a `uiState()` reader in its deps,
  so it threads through there; `web/server.mjs` persists/serves the tier alongside the
  existing ui-state; `main.js`'s inline `startScreencast` uses `tierToParams(defaultTier)`.
- **Persistence:** web-only, `localStorage` key + ui-state, identical pattern to the t019
  `inputTransport` pref in `settings-dialog.tsx` (web-only control, hidden on Electron via
  the same `getCaps()` gate). No new settings-store field on the Electron `settings.json`.
- **UI:** `src/components/settings-dialog.tsx` gains a 3-way segmented control near the
  connection/transport group; selecting a tier writes the pref and triggers a reconnect so
  it applies without a manual disconnect (reuse the existing reconnect path the transport
  picker calls).
- **New ADR needed?** no — this is a tuning knob over the existing screencast within
  ADR-0006 (web proxy/SSE transport) and ADR-0002 (viewport/screencast); it introduces no
  new architectural seam.

```ts
// src/lib/quality-tier.ts — the contract, not the file path
type QualityTier = "sharp" | "balanced" | "snappy"

interface ScreencastQuality {
  jpegQuality: number   // CDP Page.startScreencast `quality`
  everyNthFrame: number // server frame-rate cap (t054)
}

const DEFAULT_TIER: QualityTier = "balanced"
function tierToParams(tier: QualityTier): ScreencastQuality
function parseTier(raw: string | null): QualityTier // garbage → DEFAULT_TIER
```

## Out of scope

- The codec swap (WebRTC / WebCodecs) — deferred to a data-driven v0.2 call; this task
  stays on JPEG screencast.
- The always-on metrics / RTT-jitter estimator (t057) and the toggleable latency HUD
  (t059, outer ring) — a tier picker is a manual lever, not auto-adaptation. No automatic
  tier selection based on measured RTT.
- The ack-after-paint backpressure (t056) — orthogonal; one frame in flight is a separate
  knob from quality/rate.
- Any Electron-side picker UI or per-tab tier override — Electron uses the default tier;
  the tier is a single global web pref.

## Definition of Done

- [ ] Layer 1 tests written and green (`quality-tier.ts`).
- [ ] Layer 2 smoke checklist completed with a live Remote Browser.
- [ ] Layer 3 screenshots captured and committed.
- [ ] `pnpm check` (touched files) clean (Biome — lint + format).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green.
- [ ] `pnpm web` boots cleanly and the picker changes sharpness/cadence end-to-end.
- [ ] CLAUDE.md / `src/lib/CLAUDE.md` updated for the new `quality-tier` module and the
      screencast-params change on both connect paths.
- [ ] No commented-out code, no `console.log` debris, no AI attribution.
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t055 in commit.

## Notes

The default lives in the pure module, so a fresh visitor (and the whole Electron build)
gets `balanced` without any stored pref. Keep the three pairs conservative — Sharp should
look clearly crisper and Snappy clearly lighter, with Balanced matching today's behavior
(`quality: 80`, t054's default cap) so existing users see no change until they opt in.
