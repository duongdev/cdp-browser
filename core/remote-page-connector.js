// Backend-agnostic Remote Page connector. Owns the whole connect/disconnect
// choreography for the single live Remote Page socket (ADR-0001) behind a small
// surface, hiding the `activeWs` / `cachedMetrics` / `connectId` mutables that used
// to be scattered across the backend. All effects arrive by injection — a
// `transport(wsUrl)` factory (WebSocket-shaped), the `/json` endpoint builders, a
// `config()`/`uiState()`/`themeDark()` settings reader, and `activate`/`listTargets`
// fetchers — so the same module satisfies the web proxy and the Electron main process.
//
// The connector emits raw CDP messages (and close) to its host through `onEvent`/
// `onClose`; the host fans them out exactly as before (frame ack, broadcast, fast
// path). It governs only the Remote Page screencast/input socket — not the
// Notification Side-Channel sockets (ADR-0003).
//
// CommonJS so both web/server.mjs and main.js can import by path. Pure choreography
// + a fake transport make the ordering, the single-socket invariant, the connectId
// race-guard, and the metric re-apply (ADR-0002) unit-testable. Tested by
// remote-page-connector.test.ts.

const { emulatedMediaParams } = require("./theme-emulation")
const { everyNthFrameFor } = require("./frame-throttle")
const { tierToParams, parseTier } = require("./quality-tier")

const WS_OPEN = 1
const wsOpen = (ws) => !!ws && ws.readyState === WS_OPEN

// Shallow value-compare for the small flat device-metrics object (width/height/
// deviceScaleFactor/mobile). Used to skip re-issuing identical metrics across a switch.
const sameMetrics = (a, b) => {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => a[k] === b[k])
}

// Relay-side fresh-frame-wins drop rate (t054): the host throttles broadcasts to this
// rate (server-side, via createFrameThrottle) so a slow link drains the freshest frame
// instead of a backlog of stale ones. 30fps is invisible on a fast LAN and only bites
// when the link can't drain frames. This is orthogonal to the per-tier producer cap
// below — the relay drop rate is a fixed ceiling; the quality tier (t055) picks how many
// frames the remote browser composites to begin with (everyNthFrame) plus the JPEG
// quality, read from ui-state at connect time so neither path hardcodes the numbers.
const SCREENCAST_TARGET_FPS = 30
// Kept for the keep-in-sync note in main.js and back-compat; the tier mapping now owns the
// producer cap, so this is just the default tier's everyNthFrame.
const SCREENCAST_EVERY_NTH_FRAME = everyNthFrameFor(SCREENCAST_TARGET_FPS)

// deps = { transport, endpoints:{activate,list}, config, uiState, themeDark,
//          activate, listTargets, settle?, now? }
function createRemotePageConnector(deps) {
  const { transport, endpoints, config, uiState, themeDark } = deps
  // Injected so tests resolve without timers; real backends wait ~200ms for the
  // remote browser to promote the activated tab before listing its WS url.
  const settle = deps.settle || (() => new Promise((r) => setTimeout(r, 200)))

  let activeWs = null
  let connectId = 0
  let cmdId = 100
  let cachedMetrics = null
  // Idempotence guards for the device-metrics step. The override is bound to the
  // target and survives a socket swap, so re-issuing it on every (re)connect bounces
  // the remote viewport on each tab switch. We track the last metrics actually applied
  // and skip a re-issue when unchanged; the adaptive-OFF release dance (take-ownership
  // + clear of a crash-pinned override) runs at most once per process.
  let appliedMetrics = null
  let releasedPinnedOverride = false

  const eventCbs = new Set()
  const closeCbs = new Set()
  const emitEvent = (data) => {
    for (const cb of eventCbs) cb(data)
  }
  const emitClose = () => {
    for (const cb of closeCbs) cb()
  }

  function rawSend(ws, method, params) {
    if (wsOpen(ws)) ws.send(JSON.stringify({ id: cmdId++, method, params: params || {} }))
  }
  function applyThemeEmulation(ws) {
    if (!wsOpen(ws)) return
    rawSend(ws, "Emulation.setEmulatedMedia", emulatedMediaParams(uiState().syncTheme, themeDark()))
  }
  function clearAdaptiveOverride(ws) {
    if (uiState().adaptiveViewport && wsOpen(ws)) {
      rawSend(ws, "Emulation.clearDeviceMetricsOverride", {})
      // Released to native — the next connect must re-apply the cached override.
      appliedMetrics = null
    }
  }

  // `releaseOverride` distinguishes a real disconnect (host-initiated teardown → release
  // the override to native) from a switch (keep the override sent to the old socket,
  // but clear appliedMetrics so the next connect always re-sends to the fresh target).
  function teardown(ws, releaseOverride) {
    if (!ws) return
    if (releaseOverride) {
      clearAdaptiveOverride(ws)
    } else {
      // Switch: the old socket is going away but we do NOT clear the override on the
      // remote (it's bound to the target and we're switching to a *different* target).
      // Reset appliedMetrics so the next connect re-sends the override to the new
      // target — the "skip unchanged" guard must only apply within the same target.
      appliedMetrics = null
    }
    // Detach before close so the close we trigger (switch teardown) never reaches the
    // host as a drop — same primitive disconnect() uses. Only a close we did NOT
    // initiate (a real drop) keeps its onClose attached and surfaces "disconnected".
    if (ws.__detach) ws.__detach()
    try {
      ws.close()
    } catch {}
  }

  async function connect({ tabId }) {
    if (activeWs) {
      const old = activeWs
      activeWs = null
      // Switch teardown: resets appliedMetrics (new target, new override needed).
      // Does NOT clear the override on the old socket (it's a different target).
      teardown(old, false)
    }
    const myId = ++connectId
    try {
      await deps.activate(endpoints.activate(config().host, config().port, tabId))
      // Give the remote browser time to promote the tab before we list its WS URL.
      await settle()
      if (myId !== connectId) return { error: "cancelled" }
      const tabs = await deps.listTargets()
      const tab = Array.isArray(tabs) ? tabs.find((t) => t.id === tabId) : null
      if (!tab) return { error: "Tab not found" }

      return await new Promise((resolve) => {
        const ws = transport(tab.webSocketDebuggerUrl)
        const onMessage = (data) => {
          if (activeWs !== ws) return
          emitEvent(data)
        }
        const onClose = () => {
          if (activeWs === ws) activeWs = null
          emitClose()
        }
        const onError = (e) => {
          if (activeWs === ws) activeWs = null
          resolve({ error: e.message })
        }
        // Detach our listeners once the socket leaves the active slot so a torn-down
        // or superseded socket can never fire onEvent/onClose afterward (clean teardown).
        ws.__detach = () => {
          if (ws.off) {
            ws.off("message", onMessage)
            ws.off("close", onClose)
            ws.off("error", onError)
          }
        }
        ws.on("open", () => {
          if (myId !== connectId) {
            try {
              ws.close()
            } catch {}
            return resolve({ error: "cancelled" })
          }
          activeWs = ws
          resolve({ ok: true })
          rawSend(ws, "Page.enable")
          rawSend(ws, "Input.enable")
          applyThemeEmulation(ws)
          const ui = uiState()
          if (ui.adaptiveViewport && cachedMetrics) {
            // The override is bound to the target and survives the socket swap, so a
            // switch with unchanged metrics needs no re-issue — skip it to avoid a
            // no-op resize that visibly bounces the remote viewport.
            if (!sameMetrics(cachedMetrics, appliedMetrics)) {
              rawSend(ws, "Emulation.setDeviceMetricsOverride", cachedMetrics)
              appliedMetrics = cachedMetrics
            }
          } else if (!ui.adaptiveViewport && !releasedPinnedOverride) {
            // Release any override a prior crash left pinned (take ownership, then clear).
            // Latched to run at most once per process — after the first release the remote
            // stays native, so subsequent switches send neither override nor clear (no bounce).
            releasedPinnedOverride = true
            rawSend(ws, "Emulation.setDeviceMetricsOverride", {
              width: 1400,
              height: 900,
              deviceScaleFactor: 1,
              mobile: false,
            })
            rawSend(ws, "Emulation.clearDeviceMetricsOverride", {})
          }
          // Quality-latency tier (t055): jpegQuality + everyNthFrame come from the picked
          // tier in ui-state (default balanced ⇒ quality 80 / everyNthFrame 2, today's
          // behavior). Re-read on every (re)connect so a mid-session tier change applies
          // on the next reconnect, like the adaptive-viewport metrics re-apply above.
          const { jpegQuality, everyNthFrame } = tierToParams(parseTier(ui.qualityTier))
          rawSend(ws, "Page.startScreencast", {
            format: "jpeg",
            quality: jpegQuality,
            maxWidth: 3000,
            maxHeight: 2000,
            everyNthFrame,
          })
          rawSend(ws, "Runtime.evaluate", {
            expression: "document.addEventListener('contextmenu',e=>e.preventDefault(),true)",
          })
        })
        ws.on("message", onMessage)
        ws.on("close", onClose)
        ws.on("error", onError)
      })
    } catch (e) {
      return { error: e.message }
    }
  }

  function disconnect() {
    // Cancel any in-flight connect (a late-opening socket sees myId !== connectId).
    connectId++
    if (activeWs) {
      const old = activeWs
      activeWs = null
      // Host-initiated, so detach-before-close: the host already knows it disconnected.
      // A real disconnect releases the override to native (unlike a switch).
      teardown(old, true)
    }
  }

  function invoke(method, params) {
    const ws = activeWs
    if (!wsOpen(ws)) return Promise.resolve({ error: "not connected" })
    const id = cmdId++
    return new Promise((resolve) => {
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id === id) {
            ws.off("message", handler)
            resolve(msg.result || {})
          }
        } catch {}
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params: params || {} }))
      setTimeout(() => {
        ws.off("message", handler)
        resolve({ error: "timeout" })
      }, 3000)
    })
  }

  function send(method, params) {
    if (method === "Emulation.setDeviceMetricsOverride") {
      cachedMetrics = params
      // appliedMetrics records what the remote ACTUALLY received, so only stamp it when
      // the send goes out on an open socket (below). If we're mid-reconnect (activeWs
      // null during the backoff window), the remote never gets these metrics — recording
      // them as applied would make the next same-target reconnect wrongly skip the
      // re-issue (sameMetrics(cached, applied)===true) and leave the page native-size →
      // letterbox. Leaving appliedMetrics untouched lets that reconnect re-apply.
    } else if (method === "Emulation.clearDeviceMetricsOverride") {
      cachedMetrics = null
      appliedMetrics = null
    }
    // Stamp appliedMetrics only when the metrics send actually transmits on an open
    // socket — rawSend itself is a no-op when the socket is closed, and appliedMetrics
    // must mirror exactly what the remote received.
    if (method === "Emulation.setDeviceMetricsOverride" && wsOpen(activeWs)) {
      appliedMetrics = params
    }
    rawSend(activeWs, method, params)
  }

  return {
    connect,
    disconnect,
    isConnected: () => wsOpen(activeWs),
    setMetricsOverride: (override) => {
      cachedMetrics = override
    },
    // Re-apply theme emulation to the live socket (host calls this when the theme
    // source or OS scheme changes mid-session). No-op when not connected.
    applyTheme: () => applyThemeEmulation(activeWs),
    send,
    invoke,
    // The active socket id-stamped sender for the host to ack frames with.
    ackFrame: (sessionId) => rawSend(activeWs, "Page.screencastFrameAck", { sessionId }),
    onEvent: (cb) => {
      eventCbs.add(cb)
      return () => eventCbs.delete(cb)
    },
    onClose: (cb) => {
      closeCbs.add(cb)
      return () => closeCbs.delete(cb)
    },
  }
}

module.exports = {
  createRemotePageConnector,
  SCREENCAST_TARGET_FPS,
  SCREENCAST_EVERY_NTH_FRAME,
}
