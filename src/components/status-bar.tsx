import {
  Alert02Icon,
  ArrowReloadHorizontalIcon,
  InformationCircleIcon,
  Loading03Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { type ReactNode, useEffect, useState } from "react"
import { useLatencyHudEnabled } from "@/components/latency-hud"

interface StatusBarProps {
  loading: boolean
  loadingText: string
  onOpenSettings?: () => void
  /** Force-reconnect the Remote Page (t042). Wired only on the web build, where the bridge
   *  exposes `reconnect()`; the button shows in the terminal error state beside settings. */
  onReconnect?: () => void
  /** Optional right-aligned slot for the latency HUD (t059). Self-contained — it renders
   *  nothing when its own toggle is off, but its mere presence keeps the bar shown so the
   *  readout has a home even when there's no transient status row. */
  latencyHud?: ReactNode
}

// The prominent Reconnect affordance shows only in the terminal "down" state — the post-
// ceiling "Error: Disconnected" t040 settles on, and any other connect failure. Not while
// reconnecting (the loop owns the retry) and not when idle/live. Pure so it's unit-testable.
export function shouldOfferReconnect(loadingText: string): boolean {
  return loadingText.startsWith("Error")
}

// Transient status (connecting / errors) floats over the bottom of the content
// instead of a hard-to-see mid-viewport overlay. It reserves no layout height — the
// host pins it absolute (t064) so the screencast stays full-bleed to the bottom edge
// (no reserved bar, no safe-area strip standing out under the home indicator). When
// idle it paints nothing; only its own content keeps clear of the home indicator.
// Non-error loading is delayed 500ms so fast tab switches don't flash a spinner;
// errors show immediately. Empty unless the latency HUD is on, which keeps it
// mounted as the HUD's home.
export function StatusBar({
  loading,
  loadingText,
  onOpenSettings,
  onReconnect,
  latencyHud,
}: StatusBarProps) {
  const isError = loadingText.startsWith("Error")
  // Idle states (e.g. "No tab selected") aren't progress — show without a spinner.
  const isIdle = loadingText === "No tab selected"
  // Reconnecting (t040) is progress, not an error — spinner + muted, shown promptly (a real
  // drop is a meaningful state change, not a fast tab-switch flash to be delayed away).
  const isReconnecting = loadingText === "Reconnecting…"
  const [visible, setVisible] = useState(false)
  // The HUD owns its enabled flag (latency-hud.tsx). The bar mirrors it so it stays mounted
  // for the HUD even when there's no transient status, and adds no DOM when the HUD is off.
  const hudOn = useLatencyHudEnabled(latencyHud != null)

  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    if (isError || isIdle || isReconnecting) {
      setVisible(true)
      return
    }
    const timer = setTimeout(() => setVisible(true), 500)
    return () => clearTimeout(timer)
  }, [loading, isError, isIdle, isReconnecting])

  // Show a status row while loading; otherwise show nothing in the left region (the bar can
  // still be present just for the HUD). The HUD never replaces an error — it sits beside it.
  const showStatus = visible && loading
  if (!showStatus && !hudOn) return null

  return (
    // Floating bottom pill: self-contained background + border so the bar is only visually
    // present when it has content — no full-width strip when idle, so content stays full-bleed
    // under the home indicator. True fullscreen on iPad — the pill sits flush at the bottom
    // edge with NO bottom safe-area inset (the home indicator overlays the content).
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-1.5 min-h-6 px-3 text-[11px] bg-card border-t border-border text-muted-foreground select-none [&>*]:pointer-events-auto">
      {showStatus &&
        (isError ? (
          <>
            <HugeiconsIcon className="size-3 text-red-500 shrink-0" icon={Alert02Icon} />
            <span className="truncate text-red-500">{loadingText}</span>
            {onReconnect && shouldOfferReconnect(loadingText) && (
              <button
                // Hit-slop (.touch-slop-y, t048): a coarse pointer (iPad finger) gets a ≥44pt
                // tap area via vertical padding + matching negative margin, so the slim status
                // bar's visual height is unchanged on a fine pointer. Reads as an action.
                className="flex items-center gap-1 text-primary hover:underline shrink-0 ml-1 touch-slop-y"
                onClick={onReconnect}
                type="button"
              >
                <HugeiconsIcon className="size-3" icon={ArrowReloadHorizontalIcon} />
                Reconnect
              </button>
            )}
            {onOpenSettings && (
              <button
                className="flex items-center gap-1 text-primary hover:underline shrink-0 ml-1 touch-slop-y"
                onClick={onOpenSettings}
                type="button"
              >
                <HugeiconsIcon className="size-3" icon={Settings01Icon} />
                Connection settings
              </button>
            )}
          </>
        ) : isIdle ? (
          <>
            <HugeiconsIcon className="size-3 shrink-0" icon={InformationCircleIcon} />
            <span className="truncate">{loadingText}</span>
          </>
        ) : (
          <>
            <HugeiconsIcon className="size-3 animate-spin shrink-0" icon={Loading03Icon} />
            <span className="truncate">{loadingText}</span>
          </>
        ))}
      {hudOn && latencyHud}
    </div>
  )
}
