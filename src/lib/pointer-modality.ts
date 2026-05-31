// Runtime input-modality signal for the touch-target system (t048 / ADR-0009).
//
// The CSS in index.css gates its 44pt touch bumps on `html.coarse-input` instead of
// `@media (pointer: coarse)`, because a standalone iPad PWA reports `pointer: coarse`
// even when a Magic Keyboard trackpad is driving it — so the media query leaves the
// dense layout permanently inflated for a keyboard-primary user. We seed the class from
// the media query (correct for pure-touch and pure-mouse devices) and then flip it on the
// first real pointer event: a `touch` pointer means coarse, a `mouse`/`pen` pointer means
// fine. Detaching the keyboard and switching to finger re-flips it with no reload.
export function initPointerModality(): void {
  if (typeof window === "undefined" || !window.matchMedia) return
  const html = document.documentElement
  let coarse = window.matchMedia("(pointer: coarse)").matches
  html.classList.toggle("coarse-input", coarse)

  const set = (next: boolean) => {
    if (next === coarse) return
    coarse = next
    html.classList.toggle("coarse-input", next)
  }
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === "touch") set(true)
    else if (e.pointerType) set(false) // mouse | pen — precise pointer in use
  }
  window.addEventListener("pointerdown", onPointer, true)
  window.addEventListener("pointermove", onPointer, true)
}
