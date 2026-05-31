# ADR-0009: Touch is a co-primary input surface (Magic Keyboard primary; finger secondary)

- **Status:** Accepted
- **Date:** 2026-05-30

## Context

The original conventions (`ux.md`, `product.md`) assumed a desktop Electron app driven by mouse and keyboard, and stated "no touch" explicitly. That assumption is stale. The real daily-driver surface is the web build installed as a PWA on an iPad (see ADR-0008's context and the web-PWA-priority decision), and the iPad is used two ways:

- **Primarily, with a Magic Keyboard.** The trackpad produces real mouse events and the hardware keys type — functionally identical to a desktop, and already fully supported.
- **Secondarily, finger-only on the couch.** Reading and tapping; typing is rare.

Finger-only use is broken today in a specific way. `src/components/viewport.tsx` carries only `onMouseDown` / `onMouseMove` / `onMouseUp` / `onWheel` handlers. Safari synthesizes a mouse click from a tap, so links work — but a finger **drag does not scroll** the remote page (no synthesized wheel), and there is **no way to type** without a hardware keyboard. The browser may also pan the app shell instead of forwarding the gesture, because the screencast canvas has no `touch-action` lock.

## Decision

Treat touch as a **co-primary input surface**, not an unsupported mode. For v0.1.0:

1. **Magic Keyboard + trackpad remains the primary, fully-supported path** — unchanged.
2. **Add a lightweight finger touch layer that maps onto the existing mouse/input pipeline**, not a new event system:
   - finger drag → `mouseWheel` scroll deltas,
   - single tap → click at the mapped coords (reusing `toRemoteCoords` letterbox math),
   - long-press → right-click / context menu.
   The screencast canvas gets `touch-action: none` so the browser doesn't pan the shell instead of forwarding the gesture.
3. **Defer to v0.2:** the on-screen-keyboard bridge (a hidden input + `Input.insertText` for finger-only typing) and full `Input.dispatchTouchEvent` fidelity (pinch-zoom, momentum / inertial scrolling, multi-touch). Couch typing is rare enough that grabbing the hardware keyboard for it is acceptable for v0.1.0.

## Consequences

**Easier:**
- Finger-only couch use becomes genuinely usable (scroll + tap + long-press) with minimal new surface area, because it reuses `toRemoteCoords` and the existing mouse path rather than a parallel event system.
- The trackpad path is untouched — zero regression risk to the primary surface.
- The convention now authorizes touch work (convention-before-code), unblocking the tasks below.

**Harder:**
- No pinch-zoom and no inertial scrolling in v0.1.0; scrolling is plain wheel-delta.
- No finger typing in v0.1.0 — the couch user must dock the keyboard to type.
- Synthesized mouse events from touch must be carefully distinguished from real trackpad events so the two paths don't double-fire — especially the settings mouse-leave auto-close, which is gated to fine-pointer (see t049).
- A wrong-feeling touch-scroll (wheel-delta tuning) is a real risk to manage during implementation.

## Alternatives

- **Stay desktop / keyboard-only; require the Magic Keyboard always docked** — rejected. The couch case is real, and "open the keyboard to scroll" fails `product.md`'s daily-driver bar.
- **Go full `Input.dispatchTouchEvent` with real multi-touch now** — rejected for v0.1.0. That is an L/high-risk new `InputIntent` variant plus a remote-page seam, buying fidelity (pinch / momentum) the 90% couch case (scroll / tap) doesn't need. Deferred to v0.2 as a fidelity upgrade.
- **Build the on-screen-keyboard bridge now** — rejected. XL/high risk, the single riskiest item; couch typing is rare. Deferred to v0.2.

---

This ADR is referenced by tasks t033 (convention + ADR), t047 (canvas touch-action lock), t048 (44pt targets), t049 (settings touch dismiss), and t051 (touch scroll/tap forwarding).
