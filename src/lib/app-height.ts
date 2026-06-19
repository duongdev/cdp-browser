// Robust full-viewport height + keyboard-follow for the iOS standalone PWA.
//
// On a home-screen PWA, iOS reports a stale (too-short) viewport height on first paint,
// so `body { height: 100dvh }` leaves a blank strip at the bottom until something forces
// a recompute. We pin the height to the live visual-viewport height via `--app-h` and
// re-measure across the post-launch settle (rAF + a couple of timeouts) and on every
// resize/orientation change. `--app-h` only overrides the `100dvh` fallback once JS sets
// it, so non-PWA/desktop and the pre-JS first paint are unchanged.
//
// We track `visualViewport.height` (not `innerHeight`): on iOS the software keyboard
// shrinks the visual viewport, so a height-pinned body keeps a bottom-anchored composer
// above the keyboard.
//
// Keyboard-follow (t083 follow-up): height alone is not enough. When the keyboard opens,
// iOS shifts the VISUAL viewport up (`visualViewport.offsetTop > 0`) while the LAYOUT
// viewport stays put, so a bottom-anchored bar floats to the top of the screen with a big
// blank gap down to the keyboard. We also publish `--vv-top` (the offset) and set an
// `html.kb-open` flag so the app root can translate to follow the visual viewport, and the
// composer can collapse the home-indicator inset the keyboard is covering. Closed keyboard
// => offset 0 => `kb-open` off => zero effect (byte-identical to the pre-follow layout).
export function initAppHeight(): void {
  if (typeof window === "undefined") return
  const root = document.documentElement
  const set = () => {
    const vv = window.visualViewport
    const h = vv?.height ?? window.innerHeight
    root.style.setProperty("--app-h", `${Math.round(h)}px`)
    const top = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0
    root.style.setProperty("--vv-top", `${top}px`)
    // Threshold (not `> 0`) so sub-pixel jitter / a stray 1px offset never toggles the
    // transform; a real keyboard offset is hundreds of px.
    root.classList.toggle("kb-open", top > 40)
  }
  // Coalesce the high-frequency listeners to one write per frame — the visualViewport `scroll`
  // event fires rapidly as the caret line moves while typing in the composer (the keyboard
  // follow path), and `set()` writes layout-affecting CSS vars.
  let raf = 0
  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      set()
    })
  }
  set()
  window.addEventListener("resize", schedule)
  window.addEventListener("orientationchange", set)
  window.visualViewport?.addEventListener("resize", schedule)
  // The offset changes via a viewport SCROLL, not a resize — must listen to both, or the
  // composer won't follow the keyboard as the caret line moves.
  window.visualViewport?.addEventListener("scroll", schedule)
  // Catch the iOS standalone settle that otherwise needs a manual resize.
  requestAnimationFrame(set)
  setTimeout(set, 200)
  setTimeout(set, 600)
}
