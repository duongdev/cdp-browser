# 100 — durable per-device client prefs

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Three web-only client prefs — `qualityTier` (Sharp/Balanced/Snappy screencast preset),
`inputTransport` (Auto/WS/Stream/Batch), and `latencyHud` (status-bar readout on/off) — are
stored in `localStorage` today, so they silently reset every time the iPad PWA evicts storage
(the same wipe class the t095 push `deviceId` fix already fought). After this task each of the
three persists **per device** in server ui-state, keyed `<base>_<deviceId>` like the existing
`webPush`/`notifMutes` prefs, and survives a PWA refresh/reinstall. A phone and a desktop each
keep their own remembered values; `localStorage` is no longer the source of truth for any of them.

## Why now

`localStorage` resetting on the iPad PWA is a known papercut (see the `localstorage-resets-in-pwa`
learning): every wipe drops the user's chosen quality tier, transport mode, and HUD toggle back to
defaults with no warning. t099 fixed the notification-delivery half of the same root cause
(server-authoritative `deviceId`, device-keyed prefs surviving a wipe); this closes the
client-ergonomics half using the *same* device-keyed ui-state seam. It also removes a live
**drift bug**: `qualityTier` is currently double-stored (localStorage *and* a global ui-state key),
so the picker can show one value while the connector applies another.

## Acceptance criteria

- [x] `qualityTier`, `inputTransport`, and `latencyHud` each persist per device in server ui-state
      under `<base>_<deviceId>` and are restored after a PWA refresh / localStorage wipe.
      *(settings-store prefixes + transport remap + e2e round-trip.)*
- [x] Two web devices hold **independent** values for all three; changing one device's pref never
      changes the other's stored value. *(device-prefs isolation test + e2e second-device test.)*
- [x] `localStorage` is no longer read or written for `qualityTier` / `inputTransport` /
      `latencyHud` as a source of truth. (The transport-selector's transient last-good *probe*
      cache stays in localStorage — it is not a durable user pref.)
- [x] A device with no stored `qualityTier` slot falls back to the existing **global** `qualityTier`
      value (then the balanced default) — no device resets to balanced on first load after ship.
- [x] The shared upstream screencast still applies the **connecting device's** tier: on tier change
      (`setUiState` → `writeDevicePrefs` shadow) and on (re)connect (`getUiState` shadow reconcile)
      the renderer mirrors its per-device value into the global `qualityTier` shadow the connector
      reads — the connector stays byte-unchanged.
- [x] Changing the transport picker still reconfigures the live transport (`reconfigureInputTransport`);
      toggling the HUD still flips a mounted readout live; changing the tier still reconnects to apply.
- [x] Garbage / missing stored values degrade to the documented defaults (auto / off / balanced).
- [x] Electron is byte-unchanged (all three prefs are web-only; the shim is not installed there).
- [x] `pnpm typecheck`, `pnpm test` (1011), `pnpm test:e2e` (49), `pnpm build` all green; Biome clean on touched files.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `device-prefs.readDevicePrefs(uiState, deviceId)` — device slot wins over global/default.
- [x] `readDevicePrefs` — absent `qualityTier` slot falls back to the global `qualityTier` key,
      then to the balanced default (the migration path — no explicit migration step).
- [x] `readDevicePrefs` — absent `inputTransport` / `latencyHud` slots return `auto` / `false`.
- [x] `readDevicePrefs` — garbage values (wrong-case, non-enum, non-boolean) parse to defaults.
- [x] `readDevicePrefs` — a different `deviceId` reads a different slot (isolation).
- [x] `device-prefs.writeDevicePrefs(partial, deviceId)` — emits `<base>_<deviceId>` slots only for
      the keys present in `partial`; absent keys are omitted (no clobber).
- [x] `writeDevicePrefs` — a `qualityTier` write also emits the plain global `qualityTier` shadow;
      `inputTransport` / `latencyHud` writes do **not** touch any global key.
- [x] `device-prefs.deviceKey(base, deviceId)` — `<base>_<deviceId>` shape.
- [x] `core/settings-store.js` — the 3 new device-key prefixes round-trip through `getUiState`/
      `setUiState` and persist (extended the existing `webPush_` prefix coverage).

### Layer 2 — Server round-trip (e2e)

n/a for main-process/IPC. The **web-server round-trip** is covered by a hermetic e2e spec
(`test/e2e/server.e2e.test.ts` → "per-device client prefs — ui-state round-trip (t100)") that
POSTs the device-keyed slots + the qualityTier shadow to the real `/api/ui-state`, reads them back,
and asserts a second device's slot stays independent — proving persistence + isolation through the
actual server, not a fake. Also updated the two `cdp-web-transport` characterization tests that
seeded batch mode via `localStorage` to use the real picker path (`setUiState` + `reconfigureInputTransport`).

### Layer 3 — Visual review

**No visual delta.** The three pickers, the HUD switch, and every label/layout are byte-identical —
only the data *source* moved from localStorage to server ui-state. The user-visible behavior (pickers
restore the stored value on open; the HUD toggle flips a mounted readout live) is exercised by the
Layer-1 + Layer-2 tests above. On-device confirmation (the pickers showing the right value after a
PWA relaunch on the iPad/iPhone) folds into the standard post-deploy device check against prod.

- [x] No layout/appearance change (pickers + switch unchanged); behavior verified via L1/L2 tests.
- [ ] On-device: pickers restore stored values after a PWA relaunch (prod device check, HITL).

## Design notes

- **Contracts changed:**
  - `CdpBridge.getUiState()` return — surfaces `qualityTier` / `inputTransport` / `latencyHud`
    resolved for *this* device (plain names), same shape the pickers already read.
  - `CdpBridge.setUiState(partial)` — accepts the three plain keys and remaps them to
    `<base>_<deviceId>` slots (+ the `qualityTier` global shadow) before POST, mirroring the
    existing `webPush`/`notificationsEnabled`/`notifMutes` remap.
  - `core/settings-store.js` `DEVICE_KEY_PREFIXES` gains `qualityTier_`, `inputTransport_`,
    `latencyHud_`.
- **New modules:**
  - `src/lib/device-prefs.ts` (pure) — declarative pref table + `readDevicePrefs` /
    `writeDevicePrefs` / `deviceKey`. Owns the remap, defaults, parse-guards, and the qualityTier
    global-shadow rule in one testable place; replaces hand-rolled if-ladders for the new prefs.
    The CJS side (`core/settings-store.js`) keeps its own prefix list (ESM↔CJS duplication,
    precedented by `notif-mutes.ts` ↔ `core/notif-mutes.js`).
- **Quality-tier live mirror (surfaced by /polish):** dropping the `qualityTier` localStorage key
  broke `viewport.tsx`'s synchronous resize reissue, which read that key to preserve the tier on
  `Page.startScreencast` (t099) — it would have silently reset every resize to balanced. Fixed with
  a live in-memory mirror in `quality-tier.ts` (`readCurrentTier`/`setCurrentTier`), seeded from
  ui-state at boot (`app.tsx`) + on picker change (`settings-dialog.tsx`), read by the reissue —
  same shape as `latency-hud.tsx`'s flag. The dead `QUALITY_TIER_KEY` export was removed.
- **New ADR needed?** No — this is the same device-keyed ui-state pattern as t093/t095 (ADR-0014
  territory), a persistence-location change, not a new architectural decision.

Data flow (types, not paths):

```ts
// pure module — the single owner of the remap + defaults + shadow
type DevicePrefs = {
  qualityTier: "sharp" | "balanced" | "snappy"
  inputTransport: "auto" | "ws" | "stream" | "batch"
  latencyHud: boolean
}
// device slot → global qualityTier shadow (qualityTier only) → default
readDevicePrefs(uiState: Record<string, unknown>, deviceId: string): DevicePrefs
// { qualityTier } -> { qualityTier_<id>, qualityTier }  (shadow)
// { inputTransport } -> { inputTransport_<id> }          (no global)
writeDevicePrefs(partial: Partial<DevicePrefs>, deviceId: string): Record<string, unknown>
```

Boot ordering (server-only, no localStorage source of truth):

- `inputTransport`: the transport boots at its safe default (`auto`) and reconfigures to the stored
  per-device mode once ui-state loads — one `reconfigureInputTransport()`, usually a no-op.
- `latencyHud`: off by default; the status-bar readout appears once ui-state resolves if the device
  had it on. The live-flip event on the settings toggle is unchanged.
- `qualityTier`: the connector already applies from server ui-state on connect; the picker's shown
  value now comes from ui-state instead of a possibly-stale localStorage copy.

## Out of scope

- Any Electron pref surface — all three prefs are web-only; Electron uses `DEFAULT_TIER` + IPC and
  shows no HUD.
- Folding the existing `webPush` / `notificationsEnabled` / `notifMutes` remap into `device-prefs.ts`
  — that path carries toast-gate side-state and was just hardened in t099; leave it untouched. A
  future refactor could unify once the gate is decoupled.
- The transport-selector's last-good **probe** cache — stays in localStorage (transient probe
  optimization; losing it on a wipe costs one extra probe, not a user pref).
- Migrating the global `qualityTier` value — the read-fallback handles it implicitly; no data
  migration step.

## Definition of Done

- [x] Layer 1 tests written and green (`device-prefs.test.ts` (17) + extended `settings-store.test.ts`).
- [x] Layer 2 web round-trip covered by the hermetic e2e spec (persist + restore + isolation).
- [x] Layer 3: no visual delta (verified above); on-device confirmation deferred to the prod device check.
- [x] Moved to `docs/tasks/done/` with the `t100` ID in branch (`feat/t100-durable-per-device-client-prefs`) + commit.
