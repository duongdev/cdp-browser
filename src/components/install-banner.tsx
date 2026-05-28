import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

const BANNER_DISMISS_KEY = "last-install-banner-dismiss"
const BANNER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function InstallBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Only show on iOS Safari in non-standalone mode (not installed PWA)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    const isStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true
    const isAppleWebApp =
      (window.navigator as unknown as { standalone?: boolean }).standalone === true

    if (!isIOS || isStandalone || isAppleWebApp) return

    // Check if we've shown this recently (within 7 days)
    const lastDismiss = localStorage.getItem(BANNER_DISMISS_KEY)
    if (lastDismiss) {
      const lastDismissTime = parseInt(lastDismiss, 10)
      if (Date.now() - lastDismissTime < BANNER_COOLDOWN_MS) return
    }

    setVisible(true)
  }, [])

  const handleDismiss = () => {
    localStorage.setItem(BANNER_DISMISS_KEY, Date.now().toString())
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/10 p-3 mx-3 mb-3">
      <div className="flex-1 text-sm">
        <p className="font-medium text-foreground">Install for best experience</p>
        <p className="text-muted-foreground">
          Tap the share button then "Add to Home Screen" for notifications and better shortcuts
        </p>
      </div>
      <Button
        aria-label="Dismiss"
        className="shrink-0 h-6 w-6 p-0"
        onClick={handleDismiss}
        size="icon-xs"
        variant="ghost"
      >
        <HugeiconsIcon className="size-4" icon={Cancel01Icon} />
      </Button>
    </div>
  )
}
