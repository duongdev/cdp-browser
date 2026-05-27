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

// When E2E is on (set during bootstrap), every /api body + SSE frame is sealed under
// this key; otherwise null and everything is plaintext (as before). See t012.
import { deriveKey as envDeriveKey, open as envOpen, seal as envSeal } from "./crypto-envelope"

let e2eKey: CryptoKey | null = null
const E2E_PASS_STORE = "cdp-e2e-pass"

async function getJson(path: string) {
  const res = await fetch(path)
  if (e2eKey) return envOpen(await res.text(), e2eKey)
  return res.json()
}
async function postJson(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": e2eKey ? "text/plain" : "application/json" },
    body: e2eKey ? await envSeal(body ?? {}, e2eKey) : JSON.stringify(body ?? {}),
  })
  if (res.status === 204) return undefined
  if (e2eKey) return envOpen(await res.text(), e2eKey)
  return res.json()
}
// Raw POST of an already-serialized line (sealed envelope or JSON) — the server's body()
// opens/parses it. Used by the input fallback so a sealed batch posts verbatim.
async function postRaw(path: string, line: string) {
  await fetch(path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: line })
}

// Chrome/Edge can stream a request body (ReadableStream + duplex:'half') over HTTP/2.
// Detection per the documented pattern: duplex is read and no Content-Type is auto-set.
const SUPPORTS_REQUEST_STREAMING = (() => {
  if (typeof ReadableStream === "undefined" || typeof Request === "undefined") return false
  try {
    let duplexAccessed = false
    const hasContentType = new Request("http://x", {
      body: new ReadableStream(),
      method: "POST",
      // biome-ignore lint/suspicious/noExplicitAny: duplex not yet in lib.dom RequestInit
      get duplex() {
        duplexAccessed = true
        return "half"
      },
    } as any).headers.has("Content-Type")
    return duplexAccessed && !hasContentType
  } catch {
    return false
  }
})()

/**
 * The low-latency input path: one long-lived POST whose body streams NDJSON frames,
 * so input flushes don't each pay a fresh request's TLS/auth/RTT through the proxy
 * chain. Pairs with the SSE down-channel — no WebSocket. See t011.
 *
 * Safety: a buffering proxy (Authentik/openresty without `proxy_request_buffering off`)
 * would accept the stream but never deliver the body — input would vanish. So on open we
 * send a `probe` frame and only switch real input onto the stream once the server echoes
 * a `stream-ack` over SSE. Until confirmed (and forever, if the probe is never acked) we
 * use a per-flush POST. `notifyAck()` is called by the SSE `stream-ack` handler.
 */
function createInputChannel(postFallback: (line: string) => void) {
  const enc = new TextEncoder()
  // Give up after this many establish attempts that never get acked (no HTTP/2, or a
  // buffering proxy) and stay on the POST fallback for good — don't loop forever.
  const MAX_ATTEMPTS = 2
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let abort: AbortController | null = null
  let state: "idle" | "probing" | "streaming" | "blocked" = "idle"
  let attempts = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null

  function onSettle() {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    controller = null
    if (state === "blocked") return
    const wasStreaming = state === "streaming" // dropped after working ⇒ transient
    state = "idle"
    if (wasStreaming) attempts = 0
    else if (attempts >= MAX_ATTEMPTS) {
      state = "blocked"
      return
    }
    setTimeout(open, 1000)
  }

  function open() {
    if (!SUPPORTS_REQUEST_STREAMING || state !== "idle") return
    state = "probing"
    attempts++
    abort = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        c.enqueue(enc.encode(`${JSON.stringify({ probe: 1 })}\n`))
      },
    })
    // Resolves only when the body closes (half-duplex) — we never close it, so settling
    // means the channel dropped. Replies (incl. the probe ack) arrive over SSE.
    fetch("/api/input-stream", {
      method: "POST",
      body,
      signal: abort.signal,
      // biome-ignore lint/suspicious/noExplicitAny: duplex not yet in lib.dom RequestInit
      duplex: "half",
    } as any)
      .catch(() => {})
      .finally(onSettle)
    // No ack in the window ⇒ a buffering proxy swallowed the body (fetch hangs) ⇒ abort
    // so onSettle counts the failed attempt and eventually falls back permanently.
    watchdog = setTimeout(() => {
      if (state === "probing") abort?.abort()
    }, 3000)
  }
  open()

  return {
    send(line: string) {
      if (state === "streaming" && controller) {
        try {
          controller.enqueue(enc.encode(`${line}\n`))
          return
        } catch {
          state = "idle"
        }
      }
      postFallback(line)
    },
    notifyAck() {
      if (state === "probing") {
        if (watchdog) {
          clearTimeout(watchdog)
          watchdog = null
        }
        attempts = 0
        state = "streaming"
      }
    },
  }
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
  // Decode an SSE data payload (plaintext JSON, or a sealed envelope under E2E). When
  // sealed, decode is async — serialize through one chain so frame/event order holds.
  let sseChain: Promise<unknown> = Promise.resolve()
  // biome-ignore lint/suspicious/noExplicitAny: demuxed CDP/notification payloads are dynamic
  function onSse(data: string, fire: (msg: any) => void) {
    if (!e2eKey) {
      fire(JSON.parse(data))
      return
    }
    const key = e2eKey
    sseChain = sseChain.then(async () => fire(await envOpen(data, key)))
  }
  es.addEventListener("cdp", (e) =>
    onSse((e as MessageEvent).data, (msg) => {
      for (const cb of listeners.event) cb(msg)
    }),
  )
  es.addEventListener("disconnected", () => {
    for (const cb of listeners.disconnected) cb()
  })
  es.addEventListener("notification", (e) =>
    onSse((e as MessageEvent).data, (entry) => {
      for (const cb of listeners.notification) cb(entry)
      maybeToast(entry)
    }),
  )
  es.addEventListener("notification-activate", (e) =>
    onSse((e as MessageEvent).data, (entry) => {
      for (const cb of listeners.notificationActivate) cb(entry)
    }),
  )

  // OS toast via the web Notification API — the browser-side stand-in for the Electron
  // Notification main fired. Opt-in: gated by the `webPush` setting (the "Push
  // notifications" toggle handles the permission grant), only when the tab isn't
  // visible, and only with permission granted. Clicking re-focuses and routes through
  // the same notification-activate listeners the renderer registers.
  let webPush = false
  function maybeToast(entry: CdpNotification) {
    if (!webPush) return
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

  // Batch input + acks: coalesce moves, accumulate wheel, flush discrete immediately.
  // Non-E2E: write each batch as an NDJSON frame to the streaming channel (low latency),
  // falling back to a per-batch POST. E2E: skip streaming (the probe/async-seal/order
  // interplay isn't worth it) and post each sealed batch in order to /api/cdp-batch.
  let batcher: ReturnType<typeof createBatcher<Cmd>>
  if (e2eKey) {
    const key = e2eKey
    let chain: Promise<unknown> = Promise.resolve()
    batcher = createBatcher<Cmd>({
      schedule: (flush) => requestAnimationFrame(flush),
      send: (batch: Batch<Cmd>) => {
        chain = chain.then(async () => postRaw("/api/cdp-batch", await envSeal(batch, key)))
      },
    })
  } else {
    const inputChannel = createInputChannel((line) => void postRaw("/api/cdp-batch", line))
    es.addEventListener("stream-ack", () => inputChannel.notifyAck())
    batcher = createBatcher<Cmd>({
      schedule: (flush) => requestAnimationFrame(flush),
      send: (batch: Batch<Cmd>) => inputChannel.send(JSON.stringify(batch)),
    })
  }

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
      webPush = !!ui.webPush
      return ui
    },
    setUiState: (partial) => {
      if ("webPush" in partial) webPush = !!partial.webPush
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

// Pre-React DOM overlay that blocks until a passphrase is entered (React isn't mounted
// yet — the key must exist before any /api call). Resolves the entered string.
function promptPassphrase(showError: boolean): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div")
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,sans-serif"
    overlay.innerHTML = `<form style="display:flex;flex-direction:column;gap:12px;width:320px;padding:24px;border:1px solid #2a2a2a;border-radius:12px;background:#141414">
      <div style="font-size:14px;font-weight:600">Encrypted session</div>
      <div style="font-size:12px;color:#888;line-height:1.4">Enter the passphrase to decrypt this session.${showError ? ' <span style="color:#f87171">Wrong passphrase.</span>' : ""}</div>
      <input type="password" autocomplete="off" style="padding:8px 10px;border:1px solid #2a2a2a;border-radius:8px;background:#0a0a0a;color:#e5e5e5;font-size:13px" />
      <button type="submit" style="padding:8px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:13px;cursor:pointer">Unlock</button>
    </form>`
    const form = overlay.querySelector("form") as HTMLFormElement
    const input = overlay.querySelector("input") as HTMLInputElement
    form.addEventListener("submit", (ev) => {
      ev.preventDefault()
      if (!input.value) return
      overlay.remove()
      resolve(input.value)
    })
    document.body.appendChild(overlay)
    input.focus()
  })
}

// If the server has E2E on, establish the key before anything connects: derive from the
// passphrase (stored or prompted) + served salt, and confirm by decrypting the verifier.
async function bootstrapE2E(): Promise<void> {
  const params = await fetch("/api/crypto-params")
    .then((r) => r.json())
    .catch(() => ({ e2e: false }))
  if (!params.e2e) return
  let stored = sessionStorage.getItem(E2E_PASS_STORE) || ""
  let error = false
  for (;;) {
    const pass = stored || (await promptPassphrase(error))
    stored = ""
    const key = await envDeriveKey(pass, params.salt, params.iterations)
    try {
      await envOpen(params.verifier, key) // GCM auth fails ⇒ wrong passphrase
      e2eKey = key
      sessionStorage.setItem(E2E_PASS_STORE, pass)
      return
    } catch {
      sessionStorage.removeItem(E2E_PASS_STORE)
      error = true
    }
  }
}

/** Install the web runtime if we're not running under Electron's preload. */
export async function installWebRuntimeIfNeeded() {
  if (typeof window === "undefined" || window.cdp) return
  await bootstrapE2E()
  window.webCaps = DEFAULT_CAPS
  window.cdp = createWebCdp()
  window.local = createNoopLocal()
}
