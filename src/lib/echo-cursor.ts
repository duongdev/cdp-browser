/**
 * Echo cursor — the pure model for the viewport's optimistic local-input overlay (t052).
 *
 * On a slow link nothing moves on screen until the next remote Screencast Frame returns:
 * the cursor, the press, the click ripple all wait a full round-trip. This module owns the
 * *intent* the user already expressed — pointer position and press — so the viewport can
 * draw it instantly, ahead of the frame that confirms it a beat later.
 *
 * It is presentation-only and I/O-free: no DOM, no Canvas, no timers. Press expiry is
 * driven by an injected `now` (the component passes `performance.now()`), so the auto-clear
 * is deterministic and never leaks a real timer into the model. The component feeds it the
 * *same* client coordinates it hands to `forwardInput`, mapped through the same canvas
 * geometry, so the echo and the click can never separate.
 */

/** How long (ms) the optimistic press affordance stays lit after a press before it clears
 *  itself. Short — it's a latency cue, not a click animation. */
export const PRESS_FLASH_MS = 220

export interface Point {
  x: number
  y: number
}

/** The overlay model the viewport renders. Both fields are null when there is nothing to
 *  draw (pointer outside, disconnected, or no live frame). */
export interface EchoCursor {
  /** Canvas-space cursor position; null = hidden (no dot to draw). */
  pos: Point | null
  /** Optimistic press flash with its expiry time (in the injected `now` clock); null = none. */
  press: { x: number; y: number; until: number } | null
}

export type EchoEvent =
  | { type: "enter" | "leave" | "disconnect" }
  | { type: "move"; pos: Point }
  | { type: "press"; pos: Point }
  /** Gate: with no live frame the overlay is inert (loading/error/no tab). */
  | { type: "frame-state"; hasFrame: boolean }

/**
 * The whole echo-cursor state. `inside` tracks whether the pointer is over the viewport
 * (set by enter/leave); `hasFrame` gates everything off when no live frame is painted. The
 * derived overlay (via `view`) is null-everything unless the pointer is inside AND a frame
 * is live — so the dot never lingers over a frozen or empty viewport.
 */
export interface EchoState {
  inside: boolean
  hasFrame: boolean
  pos: Point | null
  press: { x: number; y: number; until: number } | null
}

export const initial: EchoState = { inside: false, hasFrame: true, pos: null, press: null }

/**
 * Folds one event into the state at time `now`. Pure — returns a fresh state, never mutates.
 * `press` also reaps an expired flash on every event so a stale press never out-lives its
 * window even if no further event arrives to clear it (the component also re-renders on a
 * short schedule to drop it visually).
 */
export function reduce(state: EchoState, event: EchoEvent, now: number): EchoState {
  const press = state.press && state.press.until > now ? state.press : null
  switch (event.type) {
    case "enter":
      return { ...state, press, inside: true }
    case "leave":
      return { ...state, press: null, inside: false, pos: null }
    case "disconnect":
      return { ...state, press: null, inside: false, pos: null, hasFrame: false }
    case "move":
      return { ...state, press, pos: event.pos }
    case "press":
      return {
        ...state,
        pos: event.pos,
        press: { x: event.pos.x, y: event.pos.y, until: now + PRESS_FLASH_MS },
      }
    case "frame-state":
      // Gaining a frame keeps whatever the pointer already established; losing it clears.
      return event.hasFrame
        ? { ...state, press, hasFrame: true }
        : { ...state, press: null, hasFrame: false, pos: null }
  }
}

/**
 * Derives the render-ready overlay from the state at time `now`. The cursor and press only
 * surface when the pointer is inside the viewport and a live frame is present; the press
 * additionally clears once its expiry passes. This is the single thing the component reads.
 */
export function view(state: EchoState, now: number): EchoCursor {
  if (!state.inside || !state.hasFrame) return { pos: null, press: null }
  const press = state.press && state.press.until > now ? state.press : null
  return { pos: state.pos, press }
}
