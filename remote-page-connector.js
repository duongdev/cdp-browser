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

const WS_OPEN = 1
const wsOpen = (ws) => !!ws && ws.readyState === WS_OPEN

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
    if (uiState().adaptiveViewport && wsOpen(ws))
      rawSend(ws, "Emulation.clearDeviceMetricsOverride", {})
  }

  function teardown(ws) {
    if (!ws) return
    clearAdaptiveOverride(ws)
    try {
      ws.close()
    } catch {}
  }

  async function connect({ tabId }) {
    if (activeWs) {
      const old = activeWs
      activeWs = null
      teardown(old)
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
            rawSend(ws, "Emulation.setDeviceMetricsOverride", cachedMetrics)
          } else if (!ui.adaptiveViewport) {
            // Release any override a prior crash left pinned (take ownership, then clear).
            rawSend(ws, "Emulation.setDeviceMetricsOverride", {
              width: 1400,
              height: 900,
              deviceScaleFactor: 1,
              mobile: false,
            })
            rawSend(ws, "Emulation.clearDeviceMetricsOverride", {})
          }
          rawSend(ws, "Page.startScreencast", {
            format: "jpeg",
            quality: 80,
            maxWidth: 3000,
            maxHeight: 2000,
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
      // Detach first so the close we trigger (and any late event) never reaches the
      // host — disconnect is host-initiated, the host already knows it disconnected.
      if (old.__detach) old.__detach()
      try {
        old.close()
      } catch {}
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
    if (method === "Emulation.setDeviceMetricsOverride") cachedMetrics = params
    else if (method === "Emulation.clearDeviceMetricsOverride") cachedMetrics = null
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

module.exports = { createRemotePageConnector }
