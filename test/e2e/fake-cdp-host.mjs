// Deterministic in-process "Remote Browser" for hermetic E2E tests.
// Mimics the CDP HTTP + WebSocket subset that web/server.mjs actually uses.
// Each startFakeCdpHost() returns a running instance on an ephemeral port.

import { createServer } from "node:http"
import { WebSocketServer, WebSocket } from "ws"

// A valid 1×1 white JPEG (properly formed with FFD9 end marker).
const BLANK_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APv9/9k="

function makeTarget(over = {}) {
  return {
    type: "page",
    title: over.title || "Untitled",
    url: over.url || "about:blank",
    id: over.id || `page-${Math.random().toString(36).slice(2)}`,
    ...over,
  }
}

// Start a fake CDP host. Returns an object with helper methods + stop().
export async function startFakeCdpHost(opts = {}) {
  const targets = (opts.targets || []).map(makeTarget)

  const activations = []
  const closedIds = new Set()

  // Input recording: targetId -> array of recorded {method, params}.
  // Always use the map directly — never cache the array reference in a closure,
  // because clearInputs() replaces the array and closures would see the old one.
  const inputsByTarget = new Map()

  const screencastIntervals = new Set() // interval IDs for cleanup
  // All WS connections per target (screencast + side-channel)
  const allTargetWs = new Map() // targetId -> Set<ws>

  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })

  let port = null
  const wsUrl = (id) => `ws://127.0.0.1:${port}/devtools/page/${id}`

  function liveTargets() {
    return targets
      .filter((t) => !closedIds.has(t.id))
      .map((t) => ({ ...t, webSocketDebuggerUrl: wsUrl(t.id) }))
  }

  function jsonRes(res, data, code = 200) {
    const body = JSON.stringify(data)
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length })
    res.end(body)
  }

  server.on("request", (req, res) => {
    const u = new URL(req.url, "http://x")
    const p = u.pathname

    if (req.method === "GET" && p === "/json/version") {
      return jsonRes(res, {
        Browser: "Chrome/120.0.0.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser`,
      })
    }
    if (req.method === "GET" && p === "/json") return jsonRes(res, liveTargets())

    // PUT /json/new?<url>
    if (req.method === "PUT" && p === "/json/new") {
      const newUrl = u.search ? u.search.slice(1) : "about:blank"
      const t = makeTarget({ url: newUrl, title: "New Tab" })
      targets.push(t)
      return jsonRes(res, { ...t, webSocketDebuggerUrl: wsUrl(t.id) })
    }

    const closeM = p.match(/^\/json\/close\/(.+)$/)
    if (req.method === "GET" && closeM) {
      closedIds.add(closeM[1])
      return jsonRes(res, { ok: true })
    }

    const activateM = p.match(/^\/json\/activate\/(.+)$/)
    if (req.method === "GET" && activateM) {
      activations.push(activateM[1])
      return jsonRes(res, { ok: true })
    }

    res.writeHead(404).end("not found")
  })

  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url, "http://x")
    const m = u.pathname.match(/^\/devtools\/page\/(.+)$/)
    if (!m) {
      socket.destroy()
      return
    }
    const targetId = m[1]
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!allTargetWs.has(targetId)) allTargetWs.set(targetId, new Set())
      allTargetWs.get(targetId).add(ws)

      // Ensure this target has an input bucket (may already exist from a prior connection).
      if (!inputsByTarget.has(targetId)) inputsByTarget.set(targetId, [])

      let frameCounter = 0

      ws.on("message", (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        const { id, method, params } = msg

        // Record input events directly into the map (not a closed-over reference).
        if (
          method === "Input.dispatchMouseEvent" ||
          method === "Input.dispatchKeyEvent" ||
          method === "Input.dispatchTouchEvent"
        ) {
          inputsByTarget.get(targetId).push({ method, params })
        }

        if (method === "Page.startScreencast") {
          ws.send(JSON.stringify({ id, result: {} }))
          const iv = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
              clearInterval(iv)
              screencastIntervals.delete(iv)
              return
            }
            frameCounter++
            ws.send(
              JSON.stringify({
                method: "Page.screencastFrame",
                params: {
                  data: BLANK_JPEG,
                  metadata: {
                    offsetTop: 0,
                    pageScaleFactor: 1,
                    deviceWidth: 1280,
                    deviceHeight: 800,
                    scrollOffsetX: 0,
                    scrollOffsetY: 0,
                    timestamp: Date.now() / 1000,
                  },
                  sessionId: frameCounter,
                },
              }),
            )
          }, opts.frameCadenceMs || 200)
          screencastIntervals.add(iv)
          return
        }

        if (method === "Page.screencastFrameAck") return

        // Default: empty result for all other CDP commands
        if (id !== undefined) {
          ws.send(JSON.stringify({ id, result: {} }))
        }
      })

      ws.on("close", () => {
        allTargetWs.get(targetId)?.delete(ws)
      })
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = server.address().port

  return {
    port,
    host: "127.0.0.1",

    getActivations() {
      return [...activations]
    },

    getInputs(targetId) {
      if (targetId) return [...(inputsByTarget.get(targetId) || [])]
      const all = []
      for (const v of inputsByTarget.values()) all.push(...v)
      return all
    },

    clearInputs() {
      // Replace with fresh arrays — do NOT use the old references from WS closures.
      // WS message handlers always read inputsByTarget.get(targetId) directly.
      for (const k of inputsByTarget.keys()) inputsByTarget.set(k, [])
    },

    fireNotification(targetId, payload) {
      const wsSet = allTargetWs.get(targetId)
      if (!wsSet || wsSet.size === 0) return false
      const msg = JSON.stringify({
        method: "Runtime.bindingCalled",
        params: {
          name: "__cdpNotify",
          payload: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
      })
      let sent = false
      for (const ws of wsSet) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg)
          sent = true
        }
      }
      return sent
    },

    setTargets(newTargets) {
      targets.length = 0
      for (const t of newTargets) targets.push(makeTarget(t))
    },

    getLiveTargets() {
      return liveTargets()
    },

    stop() {
      for (const iv of screencastIntervals) clearInterval(iv)
      screencastIntervals.clear()
      for (const wsSet of allTargetWs.values()) {
        for (const ws of wsSet) {
          try {
            ws.close()
          } catch {}
        }
      }
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// Default target set: plain page + Teams + Outlook (exercises adapter matching)
export const DEFAULT_TARGETS = [
  { id: "plain-1", type: "page", title: "Plain Page", url: "https://example.com/" },
  {
    id: "teams-1",
    type: "page",
    title: "Microsoft Teams",
    url: "https://teams.microsoft.com/v2/",
  },
  {
    id: "outlook-1",
    type: "page",
    title: "Outlook",
    url: "https://outlook.office.com/mail/",
  },
]
