import { useEffect, useState } from "react"

/**
 * Live coarse-pointer detection (t049 / ADR-0009). Treats touch as a co-primary
 * input surface: a user who detaches the Magic Keyboard and switches to finger
 * mid-session must flip branches with no reload, so this subscribes to the media
 * query rather than sniffing the UA once.
 *
 * Returns the current `(pointer: coarse)` state for rendering decisions (e.g. the
 * coarse-only dismiss scrim). For the per-event leave decision read the pointer
 * live with `isPointerFine()` — it reflects the value at the exact moment the
 * `mouseleave` fires, which a React-state snapshot can lag behind.
 */
export function usePointerCoarse(): boolean {
  const [coarse, setCoarse] = useState(() => isPointerCoarse())
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(pointer: coarse)")
    const onChange = () => setCoarse(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return coarse
}

/** Live read of `(pointer: fine)` — call inside an event handler, never cache it. */
export function isPointerFine(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches
}

/**
 * Live `(any-pointer: fine)` detection — true while ANY fine pointer (trackpad/mouse)
 * *exists*, even mid-touch. Deliberately not `(pointer: fine)`: that flips to coarse the
 * instant a finger touches with the trackpad still attached, which would make the virtual
 * pointer flicker on every tap. `any-pointer` stays true as long as the trackpad is there.
 * Subscribes to the media query (mirrors usePointerCoarse) so attaching/detaching a Magic
 * Keyboard flips branches with no reload.
 */
export function useAnyPointerFine(): boolean {
  const [fine, setFine] = useState(() => anyPointerFine())
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(any-pointer: fine)")
    const onChange = () => setFine(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return fine
}

function isPointerCoarse(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches
}

function anyPointerFine(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(any-pointer: fine)").matches
}
