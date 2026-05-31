/**
 * Virtual pointer — the show/hide policy for the t052 echo-cursor overlay.
 *
 * The echo cursor (`echo-cursor.ts` + `EchoOverlay` in `viewport.tsx`) is a felt-latency
 * win on a slow link, but on a Magic Keyboard trackpad it duplicates the real OS pointer and
 * reads as clutter. This module owns the *visibility* decision behind a three-way mode:
 *
 *   - `off`  — never draw it.
 *   - `on`   — always draw it (even with a trackpad).
 *   - `auto` — draw it only when there is no fine pointer (bare-iPad touch); hide it the
 *              moment a trackpad/mouse is attached.
 *
 * The mode persists server-side via ui-state (`virtualPointerMode`) so it survives a PWA
 * refresh — localStorage resets on this PWA. The pure functions here are I/O-free; the live
 * read/subscribe + the `(any-pointer: fine)` detection are owned by `viewport.tsx`.
 */

export type VirtualPointerMode = "off" | "on" | "auto"

/** The ui-state key the mode persists under (mirrors core/settings-store.js UI_DEFAULTS). */
export const VIRTUAL_POINTER_MODE_KEY = "virtualPointerMode"

const MODES: readonly VirtualPointerMode[] = ["off", "on", "auto"]

/** Coerce a raw ui-state value to a mode. Garbage / null / undefined → `auto` (the default). */
export function parseMode(raw: unknown): VirtualPointerMode {
  return MODES.includes(raw as VirtualPointerMode) ? (raw as VirtualPointerMode) : "auto"
}

/** Advance the mode one step in the toggle cycle: off → on → auto → off. Drives the
 *  ⌘K "Toggle virtual pointer" command (the only multi-state cycle the palette exposes). */
export function nextVirtualPointerMode(mode: VirtualPointerMode): VirtualPointerMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}

/**
 * The single visibility predicate. `hasFinePointer` is whether ANY fine pointer exists
 * (`(any-pointer: fine)` — a trackpad/mouse is attached), not whether the current pointer is
 * fine. Pure: off→false, on→true, auto→show only without a fine pointer.
 */
export function shouldShowVirtualPointer(
  mode: VirtualPointerMode,
  hasFinePointer: boolean,
): boolean {
  if (mode === "off") return false
  if (mode === "on") return true
  return !hasFinePointer
}

/** Fired by the settings toggle so a mounted overlay flips mode live without
 *  prop-drilling. Mirrors latency-hud's CustomEvent shape; detail carries the new mode. */
export const VIRTUAL_POINTER_EVENT = "virtualpointer:change"

/** Persist-and-notify is owned by the settings UI; this only fans the new mode to listeners. */
export function dispatchVirtualPointerMode(mode: VirtualPointerMode): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(VIRTUAL_POINTER_EVENT, { detail: mode }))
}

/** Subscribe to live mode changes; returns an unsubscribe. The handler gets the new mode. */
export function subscribeVirtualPointerMode(
  onChange: (mode: VirtualPointerMode) => void,
): () => void {
  if (typeof window === "undefined") return () => {}
  const handler = (e: Event) => onChange((e as CustomEvent<VirtualPointerMode>).detail)
  window.addEventListener(VIRTUAL_POINTER_EVENT, handler)
  return () => window.removeEventListener(VIRTUAL_POINTER_EVENT, handler)
}
