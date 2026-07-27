// Calls `dismiss` when the window loses focus, the document becomes hidden,
// or the `conversationId` changes — so hover overlays (quick-react bar,
// link-copy button) never stay painted after ⌘-Tab or a conversation switch.
//
// Usage: call unconditionally; pass the current conversation id so a switch
// counts as a dismissal even when the window stays focused.

import { useEffect } from "react"

export function useDismissOnHidden(dismiss: () => void, conversationId?: string): void {
  useEffect(() => {
    const onBlur = () => dismiss()
    const onVisibility = () => {
      if (document.visibilityState === "hidden") dismiss()
    }
    window.addEventListener("blur", onBlur)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [dismiss])

  // Dismiss on conversation switch (conversationId change).
  // biome-ignore lint/correctness/useExhaustiveDependencies: dismiss is intentionally excluded — it's stable per caller; including it would over-trigger on every render
  useEffect(() => {
    dismiss()
  }, [conversationId])
}
