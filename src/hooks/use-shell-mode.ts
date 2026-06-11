import { useEffect, useState } from "react"
import { PHONE_SHELL_MAX_WIDTH, type ShellMode, shellModeFor } from "@/lib/shell-mode"

/**
 * Live Phone Shell gate (t076, ADR-0012). Width-only by design: an iPad is
 * coarse-pointer but wide (keeps the full shell), and an iPad in narrow Split View
 * IS a narrow screen (gets the phone shell). Subscribes to the media query so
 * rotating / resizing flips shells with no reload — same pattern as
 * use-pointer-coarse.ts.
 */
export function useShellMode(): ShellMode {
  const [mode, setMode] = useState<ShellMode>(() =>
    typeof window === "undefined" ? "wide" : shellModeFor(window.innerWidth),
  )
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia(`(max-width: ${PHONE_SHELL_MAX_WIDTH}px)`)
    const onChange = () => setMode(mql.matches ? "phone" : "wide")
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return mode
}
