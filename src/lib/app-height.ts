// Robust full-viewport height for the iOS standalone PWA.
//
// On a home-screen PWA, iOS reports a stale (too-short) viewport height on first paint,
// so `body { height: 100dvh }` leaves a blank strip at the bottom until something forces
// a recompute — a manual window resize is what users hit. We instead pin the height to
// the live visual-viewport height via a CSS custom property and re-measure across the
// post-launch settle (rAF + a couple of timeouts) and on every resize/orientation change.
// `--app-h` only overrides the `100dvh` fallback once JS sets it, so non-PWA/desktop and
// the pre-JS first paint are unchanged.
//
// We track `visualViewport.height` (not `innerHeight`): on iOS the software keyboard
// shrinks the visual viewport but NOT `innerHeight`, so an `innerHeight`-pinned body keeps
// the reader composer hidden behind the keyboard (t083). Using the visual height shrinks
// the body to the visible area, keeping the bottom-anchored composer above the keyboard.
export function initAppHeight(): void {
  if (typeof window === "undefined") return
  const set = () => {
    const h = window.visualViewport?.height ?? window.innerHeight
    document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`)
  }
  set()
  window.addEventListener("resize", set)
  window.addEventListener("orientationchange", set)
  window.visualViewport?.addEventListener("resize", set)
  // Catch the iOS standalone settle that otherwise needs a manual resize.
  requestAnimationFrame(set)
  setTimeout(set, 200)
  setTimeout(set, 600)
}
