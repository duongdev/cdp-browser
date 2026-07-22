import { Notification03Icon, NotificationOff03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  ensureChatPushSubscription,
  isChatPushSubscribed,
  removeChatPushSubscription,
} from "../lib/chat-push"

// Web Push needs a standalone PWA (installed to home screen) — Safari-tab mode can't subscribe.
// Mirrors the main app's isStandalone gate; the display-mode query covers Android/desktop PWAs,
// navigator.standalone covers iOS.
function pushCapable(): boolean {
  if (
    typeof Notification === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof PushManager === "undefined"
  )
    return false
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  return !!standalone
}

/** Header bell that enables/disables Web Push for this device (t125). Hidden entirely when the
 *  environment can't do push (no APIs or a browser tab, not an installed PWA). Reflects the live
 *  subscription state; enabling requests notification permission first. */
export function NotifyToggle() {
  const [capable] = useState(pushCapable)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!capable) return
    isChatPushSubscribed()
      .then(setSubscribed)
      .catch(() => setSubscribed(false))
  }, [capable])

  if (!capable) return null

  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (subscribed) {
        await removeChatPushSubscription()
        setSubscribed(false)
      } else {
        const perm = await Notification.requestPermission()
        if (perm !== "granted") return
        const sub = await ensureChatPushSubscription()
        setSubscribed(!!sub)
      }
    } catch (e) {
      console.error("[chat-push] toggle failed:", e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      aria-label={subscribed ? "Disable notifications" : "Enable notifications"}
      aria-pressed={subscribed}
      className="text-muted-foreground"
      disabled={busy}
      onClick={toggle}
      size="icon-sm"
      variant="ghost"
    >
      <HugeiconsIcon
        className="size-4"
        icon={subscribed ? Notification03Icon : NotificationOff03Icon}
      />
    </Button>
  )
}
