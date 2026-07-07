// Per-device client prefs (t100). Three web-only prefs — the screencast quality tier, the input
// transport mode, and the latency HUD toggle — persist per device in server ui-state under
// `<base>_<deviceId>` (like webPush/notifMutes, t093/t095) so they survive an iPad-PWA storage
// wipe instead of resetting with localStorage. This pure module is the single owner of the
// plain <-> device-key remap, the defaults, the parse-guards, and the qualityTier "global shadow"
// rule; the effectful callers (cdp-web-transport.ts getUiState/setUiState, settings-dialog.tsx)
// stay thin. The CJS side (core/settings-store.js DEVICE_KEY_PREFIXES) keeps its own prefix list
// — the same ESM<->CJS duplication as notif-mutes.ts <-> core/notif-mutes.js.

import { DEFAULT_TIER, parseTier, type QualityTier } from "./quality-tier"
import type { InputTransportMode } from "./transport-selector"

export type DevicePrefs = {
  qualityTier: QualityTier
  inputTransport: InputTransportMode
  latencyHud: boolean
}

// The ui-state base key names, in Settings-display order. Each persists as `<base>_<deviceId>`.
export const DEVICE_PREF_BASES = ["qualityTier", "inputTransport", "latencyHud"] as const

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  qualityTier: DEFAULT_TIER,
  inputTransport: "auto",
  latencyHud: false,
}

const TRANSPORT_MODES: InputTransportMode[] = ["auto", "ws", "stream", "batch"]

// Unknown / wrong-type transport → auto (a stale or hand-edited value must not shape wsAllowed).
function parseTransport(raw: unknown): InputTransportMode {
  return typeof raw === "string" && (TRANSPORT_MODES as string[]).includes(raw)
    ? (raw as InputTransportMode)
    : "auto"
}

// Strictly the boolean true — a persisted string/number "1" is not a truthy HUD flag.
function parseHud(raw: unknown): boolean {
  return raw === true
}

export function deviceKey(base: string, deviceId: string): string {
  return `${base}_${deviceId}`
}

// Resolve this device's client prefs from a ui-state snapshot. Precedence per key:
//   device slot (`<base>_<deviceId>`) -> [qualityTier only] plain global shadow -> default.
// The qualityTier global fallback IS the migration path: a device with no slot inherits the
// pre-t100 global value (then balanced), so nothing resets on first load after ship.
export function readDevicePrefs(ui: Record<string, unknown>, deviceId: string): DevicePrefs {
  const qtSlot = ui[deviceKey("qualityTier", deviceId)]
  return {
    qualityTier: parseTier(
      (qtSlot !== undefined ? qtSlot : ui.qualityTier) as string | null | undefined,
    ),
    inputTransport: parseTransport(ui[deviceKey("inputTransport", deviceId)]),
    latencyHud: parseHud(ui[deviceKey("latencyHud", deviceId)]),
  }
}

// Build the ui-state partial to POST for a per-device pref change. Emits only the keys present in
// `partial`, each to its `<base>_<deviceId>` slot. A qualityTier write ALSO emits the plain global
// `qualityTier` shadow so the shared-screencast connector (core/remote-page-connector.js) applies
// this device's tier on the next (re)connect — no server change needed. inputTransport/latencyHud
// are client-only (the server never reads them), so they touch no global key.
export function writeDevicePrefs(
  partial: Partial<DevicePrefs>,
  deviceId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (partial.qualityTier !== undefined) {
    out[deviceKey("qualityTier", deviceId)] = partial.qualityTier
    out.qualityTier = partial.qualityTier // global shadow (the connector reads this)
  }
  if (partial.inputTransport !== undefined) {
    out[deviceKey("inputTransport", deviceId)] = partial.inputTransport
  }
  if (partial.latencyHud !== undefined) {
    out[deviceKey("latencyHud", deviceId)] = partial.latencyHud
  }
  return out
}
