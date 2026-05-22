import type { Size } from "./viewport-transform";

export interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: false;
}

/**
 * Maps the live canvas (CSS pixels) to a CDP `Emulation.setDeviceMetricsOverride`
 * payload. Only `width`/`height` (the CSS layout viewport) matter for the screencast —
 * its frames come back at that CSS resolution regardless of `deviceScaleFactor`. We pin
 * the factor to 1 so the remote doesn't do extra high-DPI rendering work that the
 * screencast would only throw away.
 */
export function deviceMetrics(canvas: Size): DeviceMetrics {
  return {
    width: Math.round(canvas.w),
    height: Math.round(canvas.h),
    deviceScaleFactor: 1,
    mobile: false,
  };
}

/** The remote OS window rect, as reported by `Browser.getWindowForTarget`. */
export interface Bounds {
  width: number;
  height: number;
}

/**
 * The adaptive controller's whole state. "Active" — i.e. an override is in force —
 * is precisely `enabled && !dormant`. `dormant` is the host-took-over back-off; it
 * latches until an explicit re-enable, so reconnects never silently re-impose.
 */
export interface State {
  enabled: boolean;
  dormant: boolean;
  baseline: Bounds | null;
}

export type Event =
  | { type: "enable" }
  | { type: "disable" }
  | { type: "resize"; canvas: Size; bounds: Bounds }
  | { type: "rebaseline"; bounds: Bounds }
  | { type: "poll"; bounds: Bounds };

export type Effect =
  | { type: "applyOverride"; metrics: DeviceMetrics }
  | { type: "clearOverride" };

export const initial: State = { enabled: false, dormant: false, baseline: null };

/** An override is in force only while enabled and not backed off. */
function isActive(state: State): boolean {
  return state.enabled && !state.dormant;
}

/** Slack (px) absorbing window-chrome rounding before a host resize counts. */
const DRIFT_THRESHOLD = 2;

function drifted(a: Bounds, b: Bounds): boolean {
  return (
    Math.abs(a.width - b.width) > DRIFT_THRESHOLD ||
    Math.abs(a.height - b.height) > DRIFT_THRESHOLD
  );
}

export function reduce(state: State, event: Event): { state: State; effects: Effect[] } {
  switch (event.type) {
    case "enable":
      return { state: { ...state, enabled: true, dormant: false }, effects: [] };
    case "disable":
      return {
        state: initial,
        effects: isActive(state) ? [{ type: "clearOverride" }] : [],
      };
    case "resize": {
      if (!isActive(state)) return { state, effects: [] };
      const metrics = deviceMetrics(event.canvas);
      return {
        state: { ...state, baseline: event.bounds },
        effects: [{ type: "applyOverride", metrics }],
      };
    }
    case "rebaseline":
      // Re-anchor the host-resize baseline after a reconnect without re-applying the
      // override — the main process re-applies it on connect from its cache.
      if (!isActive(state)) return { state, effects: [] };
      return { state: { ...state, baseline: event.bounds }, effects: [] };
    case "poll": {
      if (!isActive(state) || !state.baseline) return { state, effects: [] };
      if (!drifted(state.baseline, event.bounds)) return { state, effects: [] };
      return {
        state: { ...state, dormant: true, baseline: null },
        effects: [{ type: "clearOverride" }],
      };
    }
  }
}
