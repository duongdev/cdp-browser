// Pure once-per-foreground gate for push subscription re-validation.
// On app visible, allow revalidation once; on hidden, reset for next foreground.

export function createPushRevalidateGate() {
  let isVisible = false
  let revalidatedThisForeground = false

  return {
    shouldRevalidateNow(visible: boolean): boolean {
      const wasHidden = !isVisible && visible // transition hidden → visible
      isVisible = visible

      if (wasHidden) {
        revalidatedThisForeground = false
      }

      if (!isVisible) {
        return false
      }

      if (revalidatedThisForeground) {
        return false
      }

      revalidatedThisForeground = true
      return true
    },
  }
}
