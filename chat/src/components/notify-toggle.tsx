import { Notification03Icon, NotificationOff03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  ensureChatPushSubscription,
  isChatPushSubscribed,
  removeChatPushSubscription,
} from "../lib/chat-push"
import { chatShell } from "../lib/chat-shell"

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

/** Electron shell: a Switch that persists the notifications-enabled flag via the settings system.
 *  Accepts the current value + an onChange to stay in sync with useChatSettings. */
export function ElectronNotifyToggle({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Switch
      aria-label={enabled ? "Disable notifications" : "Enable notifications"}
      checked={enabled}
      onCheckedChange={onChange}
    />
  )
}

/** Web Push: header bell that enables/disables Web Push for this device (t147). Hidden entirely when
 *  the environment can't do push (no APIs or a browser tab, not an installed PWA). */
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

/** Unified notifications row control: Switch on Electron, web-push bell on web.
 *  Returns null when neither is applicable (web + not push-capable). */
export function NotifyControl({
  electronEnabled,
  onElectronChange,
}: {
  electronEnabled: boolean
  onElectronChange: (v: boolean) => void
}) {
  if (chatShell()) {
    return <ElectronNotifyToggle enabled={electronEnabled} onChange={onElectronChange} />
  }
  return <NotifyToggle />
}
