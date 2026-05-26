// t006 spike — throwaway. NOT production code. See docs/tasks/006-*.md.
//
// Single-file proxy that de-risks the web port's transport:
//   CDP host  ──WS──>  this proxy  ──SSE (frames) + POST (input)──>  browser
// No WebSocket on the browser-facing hop. Measures whether SSE can carry the
// screencast at a usable frame rate/latency through (later) an nginx front.
//
// Run:  CDP_HOST=<host> CDP_PORT=9222 PORT=7800 node spike/web-proxy/server.mjs
// Then open http://localhost:7800/ (or via nginx.conf in this dir).

import { readFile } from "node:fs/promises"
import http from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

const CDP_HOST = process.env.CDP_HOST || "localhost"
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const PORT = Number(process.env.PORT || 7800)
const HERE = dirname(fileURLToPath(import.meta.url))

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const mod = (e) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
const CDP_BUTTON = ["left", "middle", "right"]

let cdpWs = null
let cmdId = 100
const sseClients = new Set()
const stats = { frames: 0, bytes: 0, since: Date.now() }

function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) res.write(line)
}

function send(method, params = {}) {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN)
    cdpWs.send(JSON.stringify({ id: cmdId++, method, params }))
}

async function connectCdp() {
  const tabs = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`).then((r) => r.json())
  const tab = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
  if (!tab) throw new Error("no page target with a debugger url")
  console.log(`[cdp] attaching to ${tab.title} — ${tab.url}`)

  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  cdpWs = ws

  ws.on("open", () => {
    send("Page.enable")
    send("Input.enable")
    send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 3000, maxHeight: 2000 })
    console.log("[cdp] screencast started")
  })

  ws.on("message", (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg.method === "Page.screencastFrame") {
      // Ack immediately so CDP keeps sending (mirrors remote-page.ts).
      send("Page.screencastFrameAck", { sessionId: msg.params.sessionId })
      stats.frames++
      stats.bytes += msg.params.data.length
      broadcast("frame", { data: msg.params.data, metadata: msg.params.metadata })
    } else if (msg.method) {
      broadcast("cdp", { method: msg.method, params: msg.params })
    }
  })

  ws.on("close", () => {
    console.log("[cdp] socket closed")
    broadcast("disconnected", {})
    cdpWs = null
    setTimeout(() => connectCdp().catch((e) => console.error("[cdp] reconnect:", e.message)), 1000)
  })
  ws.on("error", (e) => console.error("[cdp] ws error:", e.message))
}

// Apply one coalesced batch of input intents to the remote tab.
function applyInput(intents) {
  for (const it of intents) {
    if (it.kind === "mouse") {
      const phase =
        it.phase === "pressed"
          ? "mousePressed"
          : it.phase === "released"
            ? "mouseReleased"
            : "mouseMoved"
      send("Input.dispatchMouseEvent", {
        type: phase,
        x: it.event.x,
        y: it.event.y,
        button: CDP_BUTTON[it.event.button] || "none",
        buttons: it.event.buttons || 0,
        clickCount: it.clickCount || 0,
        modifiers: mod(it.event),
      })
    } else if (it.kind === "wheel") {
      send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: it.event.x,
        y: it.event.y,
        deltaX: it.event.deltaX,
        deltaY: it.event.deltaY,
        modifiers: mod(it.event),
      })
    } else if (it.kind === "key") {
      const printable = it.phase === "down" && it.event.key.length === 1
      send("Input.dispatchKeyEvent", {
        type: it.phase === "down" ? "keyDown" : "keyUp",
        key: it.event.key,
        code: it.event.code,
        windowsVirtualKeyCode: it.event.keyCode,
        text: printable ? it.event.key : undefined,
        modifiers: mod(it.event),
      })
    }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ""
    req.on("data", (c) => {
      b += c
    })
    req.on("end", () => resolve(b))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Belt-and-braces: tell nginx not to buffer even if the conf misses it.
      "X-Accel-Buffering": "no",
    })
    res.write("retry: 2000\n\n")
    sseClients.add(res)
    console.log(`[sse] client connected (${sseClients.size} total)`)
    req.on("close", () => {
      sseClients.delete(res)
      console.log(`[sse] client gone (${sseClients.size} total)`)
    })
    return
  }

  if (url.pathname === "/input" && req.method === "POST") {
    try {
      const { intents } = JSON.parse(await readBody(req))
      applyInput(intents || [])
      res.writeHead(204).end()
    } catch (e) {
      res.writeHead(400).end(e.message)
    }
    return
  }

  if (url.pathname === "/stats") {
    const secs = (Date.now() - stats.since) / 1000
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        fps: +(stats.frames / secs).toFixed(1),
        frames: stats.frames,
        meanFrameKB: stats.frames ? +(stats.bytes / stats.frames / 1024).toFixed(1) : 0,
        sseClients: sseClients.size,
      }),
    )
    return
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await readFile(join(HERE, "index.html"))
    res.writeHead(200, { "Content-Type": "text/html" }).end(html)
    return
  }

  res.writeHead(404).end("not found")
})

server.listen(PORT, () => {
  console.log(`[http] http://localhost:${PORT}  (cdp ${CDP_HOST}:${CDP_PORT})`)
  connectCdp().catch((e) => console.error("[cdp] connect failed:", e.message))
})
