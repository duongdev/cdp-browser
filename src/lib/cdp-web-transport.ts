/**
 * Web runtime shim. In the browser there is no Electron preload, so this builds a
 * `window.cdp` that speaks the same `CdpBridge` contract over plain HTTP: POST for
 * commands, an `EventSource` (SSE) for server pushes, and a coalescing batcher so
 * high-frequency input/acks don't become one POST each. It also installs a no-op
 * `window.local` (local tabs/extensions are Electron-only) and a capability object
 * the UI reads to hide those affordances.
 *
 * Installed by `src/main.tsx` only when `window.cdp` is absent (i.e. not Electron).
 * The renderer is otherwise transport-agnostic — see the Transport seam in
 * remote-page.ts. See docs/tasks/008.
 */

import { type Batch, createBatcher } from "./input-coalesce"

export interface WebCaps {
  /** True in the browser build. */
  web: boolean
  /** Local <webview> tabs — Electron only. */
  localTabs: boolean
  /** Unpacked MV3 extensions — Electron only. */
  extensions: boolean
}

const DEFAULT_CAPS: WebCaps = { web: true, localTabs: false, extensions: false }

export function getCaps(): WebCaps {
  return (
    (typeof window !== "undefined" && window.webCaps) || {
      web: false,
      localTabs: true,
      extensions: true,
    }
  )
}

type Cmd = { method: string; params?: unknown }

async function getJson(path: string) {
  const res = await fetch(path)
  return res.json()
}
async function postJson(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status === 204) return undefined
  return res.json()
}

function createWebCdp(): CdpBridge {
  // SSE: one stream carries every server push; fan out to registered listeners.
  const listeners = {
    event: [] as ((msg: unknown) => void)[],
    disconnected: [] as (() => void)[],
    notification: [] as ((e: CdpNotification) => void)[],
    notificationActivate: [] as ((e: CdpNotification) => void)[],
    nativeTheme: [] as ((isDark: boolean) => void)[],
  }
  const es = new EventSource("/api/events")
  es.addEventListener("cdp", (e) => {
    const msg = JSON.parse((e as MessageEvent).data)
    for (const cb of listeners.event) cb(msg)
  })
  es.addEventListener("disconnected", () => {
    for (const cb of listeners.disconnected) cb()
  })
  es.addEventListener("notification", (e) => {
    const entry = JSON.parse((e as MessageEvent).data)
    for (const cb of listeners.notification) cb(entry)
    maybeToast(entry)
  })
  es.addEventListener("notification-activate", (e) => {
    const entry = JSON.parse((e as MessageEvent).data)
    for (const cb of listeners.notificationActivate) cb(entry)
  })

  // OS toast via the web Notification API — the browser-side stand-in for the
  // Electron Notification main fired. Gated by the master toggle, only when the
  // tab isn't visible, and only with permission granted. Clicking re-focuses and
  // routes through the same notification-activate listeners the renderer registers.
  let notificationsEnabled = true
  function maybeToast(entry: CdpNotification) {
    if (!notificationsEnabled) return
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return
    if (typeof document !== "undefined" && document.visibilityState === "visible") return
    const n = new Notification(entry.title || entry.source, {
      body: entry.body,
      icon: entry.icon || undefined,
    })
    n.onclick = () => {
      window.focus()
      for (const cb of listeners.notificationActivate) cb(entry)
      n.close()
    }
  }
  // Ask once, on the first user gesture (some browsers reject a bare on-load prompt).
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    const ask = () => {
      void Notification.requestPermission()
      window.removeEventListener("pointerdown", ask)
    }
    window.addEventListener("pointerdown", ask, { once: true })
  }

  // Batch input + acks: coalesce moves, accumulate wheel, flush discrete immediately.
  const batcher = createBatcher<Cmd>({
    schedule: (flush) => requestAnimationFrame(flush),
    send: (batch: Batch<Cmd>) => {
      void postJson("/api/cdp-batch", batch)
    },
  })

  // Theme: the "native" scheme is the OS preference via matchMedia, overridden by an
  // explicit theme source. We push the *resolved* dark flag to the server so it can
  // emulate prefers-color-scheme on the remote page, and notify the renderer.
  let themeSource: "system" | "light" | "dark" = "system"
  const mql =
    typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null
  const resolveDark = () => (themeSource === "system" ? !!mql?.matches : themeSource === "dark")
  function pushTheme() {
    const isDark = resolveDark()
    void postJson("/api/theme", { isDark })
    for (const cb of listeners.nativeTheme) cb(isDark)
  }
  mql?.addEventListener("change", pushTheme)

  return {
    listTabs: () => getJson("/api/tabs"),
    newTab: (url) => postJson("/api/tabs/new", { url }),
    closeTab: (id) => postJson("/api/tabs/close", { id }),
    connect: (id) => postJson("/api/connect", { id }),
    send: (method, params) => {
      if (method === "Page.screencastFrameAck") return // server acks frames itself
      const cmd: Cmd = { method, params }
      if (method === "Input.dispatchMouseEvent") {
        const type = (params as { type?: string })?.type
        if (type === "mouseMoved") return batcher.coalesce(cmd)
        if (type === "mouseWheel") return batcher.append(cmd)
        return batcher.immediate(cmd)
      }
      if (method === "Input.dispatchKeyEvent") return batcher.immediate(cmd)
      void postJson("/api/send", cmd)
    },
    invoke: (method, params) => postJson("/api/invoke", { method, params }),
    onEvent: (cb) => listeners.event.push(cb),
    onDisconnected: (cb) => listeners.disconnected.push(cb),
    getConfig: () => getJson("/api/config"),
    setConfig: (config) => postJson("/api/config", config),
    testConfig: (config) => postJson("/api/config/test", config),
    getSidebarWidth: () => getJson("/api/sidebar-width"),
    setSidebarWidth: (width) => postJson("/api/sidebar-width", { width }),
    getUiState: async () => {
      const ui = await getJson("/api/ui-state")
      notificationsEnabled = ui.notificationsEnabled
      return ui
    },
    setUiState: (partial) => {
      if ("notificationsEnabled" in partial) notificationsEnabled = !!partial.notificationsEnabled
      return postJson("/api/ui-state", partial)
    },
    setThemeSource: async (source) => {
      themeSource = source
      await postJson("/api/theme-source", { source })
      pushTheme()
    },
    getThemeSource: async () => {
      themeSource = await getJson("/api/theme-source")
      pushTheme()
      return themeSource
    },
    onNativeThemeChanged: (cb) => listeners.nativeTheme.push(cb),
    copyToClipboard: async (text) => {
      try {
        await navigator.clipboard?.writeText(text)
      } catch (e) {
        console.error("[web] clipboard write failed:", e)
      }
    },
    onSwipe: () => {}, // no trackpad swipe over the web
    getPins: () => getJson("/api/pins"),
    addPin: (pin) => postJson("/api/pins/add", pin),
    updatePin: (id, patch) => postJson("/api/pins/update", { id, patch }),
    removePin: (id) => postJson("/api/pins/remove", { id }),
    reorderPins: (pins) => postJson("/api/pins/reorder", { pins }),
    getNotifications: () => getJson("/api/notifications"),
    markNotificationRead: (id) => postJson("/api/notifications/mark-read", { id }),
    markNotificationUnread: (id) => postJson("/api/notifications/mark-unread", { id }),
    markNotificationsRead: () => postJson("/api/notifications/mark-all-read"),
    clearNotifications: () => postJson("/api/notifications/clear"),
    onNotification: (cb) => listeners.notification.push(cb),
    onNotificationActivate: (cb) => listeners.notificationActivate.push(cb),
  }
}

// Local tabs / extensions don't exist on the web; a no-op bridge keeps the callers
// that reference window.local from crashing while the UI hides their affordances.
function createNoopLocal(): LocalBridge {
  const emptyExt = () => Promise.resolve({ extensions: [] as LocalExtensionInfo[] })
  return {
    getPins: () => Promise.resolve([]),
    savePins: () => Promise.resolve(),
    getExtensions: () => Promise.resolve([]),
    pickExtension: emptyExt,
    reloadExtension: emptyExt,
    removeExtension: emptyExt,
    openActionPopup: () => Promise.resolve(),
    closeActionPopup: () => Promise.resolve(),
  }
}

/** Install the web runtime if we're not running under Electron's preload. */
export function installWebRuntimeIfNeeded() {
  if (typeof window === "undefined" || window.cdp) return
  window.webCaps = DEFAULT_CAPS
  window.cdp = createWebCdp()
  window.local = createNoopLocal()
}
