/**
 * Touch gesture classifier — the pure brain of the finger touch layer (ADR-0009).
 *
 * Fed a stream of touch samples (`{ x, y, t }` in client/canvas-relative coords) from one
 * finger gesture, it classifies the gesture and emits intents in the existing input
 * vocabulary: a short still touch is a **tap** (→ click), a held still touch is a
 * **long-press** (→ right-click), and a touch that moves is a **drag** (→ `mouseWheel`
 * scroll deltas). No DOM, no React, no timers — the long-press deadline is checked by a
 * caller-supplied `poll(now)`, so the module stays pure and unit-testable. A fresh
 * instance is created per `pointerdown` so no state leaks between gestures.
 *
 * The emitted events carry client coords; the caller flows them through
 * `forwardInput` → `resolveCoords` → `toRemoteCoords`, the same letterbox path the mouse
 * uses, so finger input lands exactly where the user touches (downscaled frames included).
 */

/** Movement beyond this distance (px) from the down point commits the gesture to a drag
 *  and cancels any pending tap/long-press. Exactly-at-threshold is still a candidate tap
 *  (the drag must *exceed* it) — this is the finger-jitter tolerance native taps allow. */
export const MOVE_THRESHOLD_PX = 10
/** An up within this window (ms) of the down, with no drag committed, is a tap. Inclusive. */
export const TAP_WINDOW_MS = 500
/** Holding a still touch to this elapsed time (ms) fires a long-press. Inclusive. */
export const LONGPRESS_MS = 500

export interface TouchSample {
  x: number
  y: number
  t: number
}

export type GestureEvent =
  | { type: "scroll"; deltaX: number; deltaY: number; x: number; y: number }
  | { type: "tap"; x: number; y: number }
  | { type: "longpress"; x: number; y: number }

export interface TouchGesture {
  /** Begin the gesture. Returns [] — classification needs at least one more sample. */
  down(s: TouchSample): GestureEvent[]
  /** A move. Once committed to a drag, emits one scroll event per step (delta vs the
   *  previous sample). Before commit, returns [] (still a candidate tap/long-press). */
  move(s: TouchSample): GestureEvent[]
  /** End the gesture. Emits a tap if it never became a drag or long-press and is within
   *  the tap window; otherwise []. */
  up(s: TouchSample): GestureEvent[]
  /** Caller-driven long-press deadline check. Emits one long-press once the hold passes
   *  `LONGPRESS_MS` (and the gesture is still a still candidate), then never again. */
  poll(now: number): GestureEvent[]
  /** Discard the in-flight gesture (e.g. `pointercancel`) — emits nothing afterward. */
  cancel(): void
}

type Phase = "candidate" | "drag" | "done"

export function createTouchGesture(): TouchGesture {
  let phase: Phase = "candidate"
  let down: TouchSample = { x: 0, y: 0, t: 0 }
  let last: TouchSample = down

  const movedPast = (s: TouchSample) => Math.hypot(s.x - down.x, s.y - down.y) > MOVE_THRESHOLD_PX

  return {
    down(s) {
      phase = "candidate"
      down = s
      last = s
      return []
    },

    move(s) {
      if (phase === "done") return []

      if (phase === "candidate") {
        if (!movedPast(s)) return []
        phase = "drag"
      }

      // Natural scroll: dragging the finger down (y grows) reveals content above, which
      // is a negative wheel deltaY; dragging right (x grows) is a negative deltaX. Each
      // step is the delta since the previous sample so deltas accumulate, not jump.
      const ev: GestureEvent = {
        type: "scroll",
        deltaX: last.x - s.x,
        deltaY: last.y - s.y,
        x: s.x,
        y: s.y,
      }
      last = s
      return [ev]
    },

    up(s) {
      if (phase !== "candidate") {
        phase = "done"
        return []
      }
      phase = "done"
      if (s.t - down.t > TAP_WINDOW_MS) return []
      return [{ type: "tap", x: s.x, y: s.y }]
    },

    poll(now) {
      if (phase !== "candidate") return []
      if (now - down.t < LONGPRESS_MS) return []
      phase = "done"
      return [{ type: "longpress", x: down.x, y: down.y }]
    },

    cancel() {
      phase = "done"
    },
  }
}
