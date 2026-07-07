// Spawns web/server.mjs as a child process on an ephemeral port, pointed at a
// fake CDP host. Returns a running handle with fetch/ws helpers and a stop().

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..")
const SERVER_PATH = join(REPO_ROOT, "web", "server.mjs")

// Probe until a TCP connection succeeds (server is truly accepting) or timeout.
function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1")
      sock.on("connect", () => {
        sock.destroy()
        resolve()
      })
      sock.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not open after ${timeoutMs}ms`))
          return
        }
        setTimeout(attempt, 50)
      })
    }
    attempt()
  })
}

export async function startWebServer(fakeCdpHost, extraEnv = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdp-e2e-"))
  const settingsPath = join(tmpDir, "settings.json")
  const notifsPath = join(tmpDir, "notifications.json")
  const subsPath = join(tmpDir, "push-subs.json")
  // Isolate the Slack registry + sweep-state files in the tmpDir too — the graceful-shutdown
  // flush (t099) writes the sweep state on every proc.kill(), so an unset path would pollute
  // the repo root on each test teardown.
  const workspacesPath = join(tmpDir, "slack-workspaces.json")
  const sweepStatePath = join(tmpDir, "slack-sweep-state.json")

  writeFileSync(settingsPath, "{}")
  writeFileSync(notifsPath, "[]")
  writeFileSync(subsPath, "[]")

  const port = await findFreePort()

  const env = {
    ...process.env,
    CDP_HOST: fakeCdpHost.host,
    CDP_PORT: String(fakeCdpHost.port),
    PORT: String(port),
    SETTINGS_PATH: settingsPath,
    NOTIFS_PATH: notifsPath,
    SUBS_PATH: subsPath,
    SLACK_WORKSPACES_PATH: workspacesPath,
    SLACK_SWEEP_STATE_PATH: sweepStatePath,
    VAPID_SUBJECT: "mailto:test@example.com",
    ...extraEnv,
  }

  const proc = spawn("node", [SERVER_PATH], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Capture output for diagnostics.
  const lines = []
  let stdoutBuf = ""
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString()
    const parts = stdoutBuf.split("\n")
    stdoutBuf = parts.pop()
    for (const line of parts) lines.push(line)
  })
  let stderrBuf = ""
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString()
    const parts = stderrBuf.split("\n")
    stderrBuf = parts.pop()
    for (const line of parts) lines.push(line)
  })

  // Wait until the TCP port is actually accepting connections (not just the log line).
  try {
    await waitForPort(port, 10000)
  } catch (e) {
    proc.kill()
    throw new Error(`Server failed to start on port ${port}: ${e.message}\n${lines.join("\n")}`)
  }

  const base = `http://127.0.0.1:${port}`

  return {
    port,
    base,
    tmpDir,
    settingsPath,
    notifsPath,
    subsPath,
    sweepStatePath,

    fetch(path, init = {}) {
      return fetch(`${base}${path}`, init)
    },

    async json(path, init = {}) {
      const res = await fetch(`${base}${path}`, init)
      return res.json()
    },

    async post(path, body) {
      // POST returns 204 for some routes (cdp-batch, send, etc.) — use fetch, not json().
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.status === 204) return { ok: true }
      return res.json()
    },

    /** Open an SSE stream, collect events until the collector returns truthy. */
    async collectSse(until, timeoutMs = 5000) {
      const events = []
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(`${base}/api/events`, {
          signal: ctrl.signal,
          headers: { Accept: "text/event-stream" },
        })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split("\n\n")
          buf = parts.pop()
          for (const part of parts) {
            if (!part.trim()) continue
            const eventLine = part.match(/^event:\s*(.+)$/m)
            const dataLine = part.match(/^data:\s*(.+)$/m)
            if (dataLine) {
              try {
                const parsed = {
                  event: eventLine ? eventLine[1].trim() : "message",
                  data: JSON.parse(dataLine[1].trim()),
                }
                events.push(parsed)
                if (until(parsed, events)) {
                  ctrl.abort()
                  return events
                }
              } catch {}
            }
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") throw e
      } finally {
        clearTimeout(timer)
      }
      return events
    },

    openWs() {
      return new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
    },

    wsReady(ws) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS ready timeout")), 5000)
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString())
            if (msg.t === "ready") {
              clearTimeout(timer)
              resolve(msg)
            }
          } catch {}
        })
        ws.on("error", reject)
      })
    },

    stop() {
      proc.kill()
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
    },
  }
}

function findFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}
