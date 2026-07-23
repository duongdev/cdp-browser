import { useCallback, useEffect, useRef, useState } from "react"
import {
  type ChatSettings,
  DEFAULT_CHAT_SETTINGS,
  readChatSettings,
  resolveDark,
  writeChatSettings,
} from "./chat-settings"

// Reuse the / build's device identity (localStorage key `cdp_device_id`, cdp-web-transport.ts) so a
// device carries ONE id across both surfaces — do not invent a second scheme. localStorage wipes on
// the iPad PWA, which is exactly why the settings VALUES live in server ui-state, not here; a wiped
// id just spawns a fresh device slot (same tradeoff as webPush/notifMutes, t066).
function getDeviceId(): string {
  const key = "cdp_device_id"
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = `device_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return `device_session_${Math.random().toString(36).slice(2, 9)}`
  }
}

/** Apply theme (`.dark` class) + density (`data-density`) to the document root. Theme `system`
 *  follows the OS via matchMedia (the pre-t154 behaviour); explicit light/dark set/remove `.dark`. */
function applySettings(s: ChatSettings): () => void {
  const root = document.documentElement
  root.setAttribute("data-density", s.density)
  root.setAttribute("data-font", s.font)
  root.setAttribute("data-mono", s.mono)
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  const paint = () => root.classList.toggle("dark", resolveDark(s.theme, mq.matches))
  paint()
  // Only `system` needs to react to OS changes; still subscribe unconditionally — resolveDark
  // ignores the OS for explicit themes, so the listener is a harmless no-op then.
  mq.addEventListener("change", paint)
  return () => mq.removeEventListener("change", paint)
}

/** Loads chat settings once from server ui-state, applies them to the DOM, and writes changes back
 *  device-keyed. Optimistic: local state updates instantly, the POST is fire-and-forget. */
export function useChatSettings() {
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS)
  const deviceId = useRef(getDeviceId()).current

  useEffect(() => {
    let alive = true
    fetch("/api/ui-state")
      .then((r) => (r.ok ? r.json() : {}))
      .then((ui) => {
        if (alive) setSettings(readChatSettings(ui as Record<string, unknown>, deviceId))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [deviceId])

  // Apply on every settings change (initial load + user edit).
  useEffect(() => applySettings(settings), [settings])

  const update = useCallback(
    (partial: Partial<ChatSettings>) => {
      setSettings((s) => ({ ...s, ...partial }))
      fetch("/api/ui-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(writeChatSettings(partial, deviceId)),
      }).catch(() => {})
    },
    [deviceId],
  )

  return { settings, update }
}
