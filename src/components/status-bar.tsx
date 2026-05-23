import {
  Alert02Icon,
  InformationCircleIcon,
  Loading03Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"

interface StatusBarProps {
  loading: boolean
  loadingText: string
  onOpenSettings?: () => void
}

// Transient status (connecting / errors) lives in a slim bottom bar instead of
// a hard-to-see mid-viewport overlay. Non-error loading is delayed 500ms so fast
// tab switches don't flash a spinner; errors show immediately. Hidden when idle.
export function StatusBar({ loading, loadingText, onOpenSettings }: StatusBarProps) {
  const isError = loadingText.startsWith("Error")
  // Idle states (e.g. "No tab selected") aren't progress — show without a spinner.
  const isIdle = loadingText === "No tab selected"
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    if (isError || isIdle) {
      setVisible(true)
      return
    }
    const timer = setTimeout(() => setVisible(true), 500)
    return () => clearTimeout(timer)
  }, [loading, isError, isIdle])

  if (!visible) return null

  return (
    <div className="flex items-center gap-1.5 h-6 px-3 text-[11px] bg-card border-t border-border text-muted-foreground select-none">
      {isError ? (
        <>
          <HugeiconsIcon className="size-3 text-red-500 shrink-0" icon={Alert02Icon} />
          <span className="truncate text-red-500">{loadingText}</span>
          {onOpenSettings && (
            <button
              className="flex items-center gap-1 text-primary hover:underline shrink-0 ml-1"
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
      )}
    </div>
  )
}
